import {
  type AgentMode,
  type AgentModeInput,
  AgentModeInputSchema,
  GENERAL_MODE_PROMPT,
  type GeneralModeSettings,
  GeneralModeSettingsSchema,
} from '@agent-test/agent-core/modes/mode.schema';
import {
  type CustomFragments,
  CustomFragmentIdSchema,
  findFragmentReferences,
  findInvalidFragmentVariables,
  findUnknownPlaceholders,
  type FragmentOverrides,
  FragmentTextSchema,
  FragmentTitleSchema,
  isCustomFragmentId,
  isPromptFragmentId,
  PROMPT_FRAGMENT_DEFAULTS,
  PROMPT_FRAGMENT_IDS,
  type PromptFragmentId,
} from '@agent-test/agent-core/modes/prompt-fragments';
import {
  resolveMode,
  type Unavailable,
} from '@agent-test/agent-core/modes/resolve-mode';
import type {
  ToolCatalogEntry,
  ToolRegistry,
} from '@agent-test/agent-core/modes/tool-registry';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSandboxConfigured, VISIBLE_WORKSPACE } from '../agent/sandbox';
import {
  type BackendHost,
  backendEnvironment,
  backendEnvPromptBlock,
  TOOL_REGISTRY,
} from '../agent/tool-registry.provider';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { McpService } from '../mcp/mcp.service';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import { SkillsService } from '../skills/skills.service';
import {
  type AgentModeView,
  type GeneralModeView,
  type PromptFragmentView,
  toCustomFragmentView,
  toFragmentView,
  toGeneralModeView,
  toModeView,
} from './mode-view';
import type {
  CreateFragmentDto,
  FragmentInputDto,
  GeneralModeInputDto,
  GeneralModePreviewDto,
  ModeInputDto,
} from './dto/mode.dto';

/** GET /modes/catalog：设置页编辑模式时的可选项与环境信息。 */
export interface ModeCatalog {
  tools: ToolCatalogEntry[];
  mcpServers: { id: string; name: string; slug: string }[];
  skills: { name: string; description: string }[];
  fragments: string[];
  generalPrompt: string;
  /** 当前用户运行环境具备的能力（UI 据此把 requires 不满足的工具标灰） */
  capabilities: string[];
}

export interface ModePreview {
  systemPrompt: string;
  unavailable: Unavailable[];
}

/**
 * 模式 CRUD + 目录 / 预览。模式是用户私有数据（按 userId 隔离）；没有内置模式，
 * 会话 modeId 为空即通用模式。删模式时引用它的会话回到通用模式。
 */
@Injectable()
export class ModesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TOOL_REGISTRY)
    private readonly registry: ToolRegistry<BackendHost>,
    private readonly skills: SkillsService,
    private readonly mcp: McpService,
    private readonly sandboxSettings: SandboxSettingsService,
  ) {}

  async list(userId: string): Promise<AgentModeView[]> {
    const rows = await this.prisma.agentMode.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toModeView);
  }

  async create(userId: string, input: ModeInputDto): Promise<AgentModeView> {
    const data = this.validate(input, await this.customFragmentIds(userId));
    const row = await this.prisma.agentMode.create({
      data: { userId, ...data },
    });
    return toModeView(row);
  }

  async update(
    userId: string,
    id: string,
    input: ModeInputDto,
  ): Promise<AgentModeView> {
    await this.findOwned(userId, id);
    const data = this.validate(input, await this.customFragmentIds(userId));
    const row = await this.prisma.agentMode.update({ where: { id }, data });
    return toModeView(row);
  }

  /** 删模式：引用它的会话 modeId 置空（回通用模式），同一事务里再删行。 */
  async remove(userId: string, id: string): Promise<{ id: string }> {
    await this.findOwned(userId, id);
    await this.prisma.$transaction([
      this.prisma.conversation.updateMany({
        where: { userId, modeId: id },
        data: { modeId: null },
      }),
      this.prisma.agentMode.delete({ where: { id } }),
    ]);
    return { id };
  }

  async catalog(userId: string): Promise<ModeCatalog> {
    const [servers, skills, env, customIds] = await Promise.all([
      this.prisma.mcpServer.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, slug: true },
      }),
      this.skills.listFor(userId),
      this.environment(userId),
      this.customFragmentIds(userId),
    ]);
    return {
      tools: this.registry.catalog(),
      mcpServers: servers,
      skills: skills
        .filter((s) => s.enabled)
        .map(({ name, description }) => ({ name, description })),
      // 内置片段在前，用户自建片段按创建时间追加（编辑器的插入按钮据此生成）
      fragments: [...PROMPT_FRAGMENT_IDS, ...customIds],
      generalPrompt: GENERAL_MODE_PROMPT,
      capabilities: [...env.capabilities],
    };
  }

  /** 按当前环境预览最终系统提示与不可用清单（纯装配，不建工具、不连 server）。 */
  async preview(userId: string, input: ModeInputDto): Promise<ModePreview> {
    const customFragments = await this.customFragments(userId);
    const data = this.validate(input, Object.keys(customFragments));
    return this.assemblePreview(
      userId,
      { id: 'preview', ...data },
      null,
      customFragments,
    );
  }

  /** 通用模式设置：没有行 = 全部默认。 */
  async getGeneral(userId: string): Promise<GeneralModeView> {
    const row = await this.prisma.generalModeSetting.findUnique({
      where: { userId },
    });
    return toGeneralModeView(row);
  }

  /** 整体替换通用模式设置（upsert）；systemPrompt 为 null = 恢复默认提示词。 */
  async updateGeneral(
    userId: string,
    input: GeneralModeInputDto,
  ): Promise<GeneralModeView> {
    const data = this.validateGeneral(
      input,
      await this.customFragmentIds(userId),
    );
    const row = await this.prisma.generalModeSetting.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toGeneralModeView(row);
  }

  /** 预览通用模式（工具 / server / 技能取全集）；systemPrompt 为 null = 默认提示词。 */
  async previewGeneral(
    userId: string,
    input: GeneralModePreviewDto,
  ): Promise<ModePreview> {
    const customFragments = await this.customFragments(userId);
    const { systemPrompt } = this.validateGeneral(
      { systemPrompt: input.systemPrompt },
      Object.keys(customFragments),
    );
    return this.assemblePreview(userId, null, systemPrompt, customFragments);
  }

  /** 片段列表：内置片段（按 PROMPT_FRAGMENT_IDS 顺序，生效正文 + 默认正文 + 是否改写过）在前，自建片段按创建时间在后。 */
  async listFragments(userId: string): Promise<PromptFragmentView[]> {
    const [overrides, customRows] = await Promise.all([
      this.fragmentOverrides(userId),
      this.prisma.customPromptFragment.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { fragmentId: true, title: true, text: true },
      }),
    ]);
    return [
      ...PROMPT_FRAGMENT_IDS.map((id) => toFragmentView(id, overrides)),
      ...customRows.map(toCustomFragmentView),
    ];
  }

  /**
   * 新建自建片段。id 不合法 / title、正文长度不合法 → MODE_INVALID；用了 {{skills_dir}} 以外的变量 →
   * MODE_FRAGMENT_INVALID_VARIABLE；同一用户下 id 已存在 → MODE_FRAGMENT_EXISTS(409)。
   */
  async createFragment(
    userId: string,
    input: CreateFragmentDto,
  ): Promise<PromptFragmentView> {
    const id = CustomFragmentIdSchema.safeParse(input.id);
    if (!id.success) throw invalidFields('id', id.error);
    const title = parseTitle(input.title);
    const text = parseFragmentText(input.text);
    try {
      const row = await this.prisma.customPromptFragment.create({
        data: { userId, fragmentId: id.data, title, text },
      });
      return toCustomFragmentView(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BusinessException(
          {
            ...ErrorCodes.MODE_FRAGMENT_EXISTS,
            message: `片段 ${id.data} 已存在`,
          },
          HttpStatus.CONFLICT,
        );
      }
      throw e;
    }
  }

  /**
   * 改片段，按种类分流：内置片段改写正文（见 updateBuiltinFragment）；自建片段改 title / 正文。
   * 既不是内置也不是该用户已有的自建片段 → MODE_FRAGMENT_NOT_FOUND(404)。
   */
  async updateFragment(
    userId: string,
    fragmentId: string,
    input: FragmentInputDto,
  ): Promise<PromptFragmentView> {
    if (isPromptFragmentId(fragmentId)) {
      if (input.title !== undefined) {
        throw invalidMessage('title: 内置片段没有显示名');
      }
      if (input.text === undefined) throw invalidMessage('text: 必填');
      return this.updateBuiltinFragment(userId, fragmentId, input.text);
    }
    await this.findOwnedFragment(userId, fragmentId);
    if (input.text === null) {
      throw invalidMessage('text: 自建片段没有默认正文，不能恢复默认');
    }
    if (input.title === undefined && input.text === undefined) {
      throw invalidMessage('title 与 text 至少提供一个');
    }
    const data: { title?: string; text?: string } = {};
    if (input.title !== undefined) data.title = parseTitle(input.title);
    if (input.text !== undefined) data.text = parseFragmentText(input.text);
    const row = await this.prisma.customPromptFragment.update({
      where: { userId_fragmentId: { userId, fragmentId } },
      data,
    });
    return toCustomFragmentView(row);
  }

  /**
   * 删自建片段。内置片段 → MODE_INVALID(400)（只能恢复默认）；不存在 → 404；
   * 仍被该用户的模式正文或自定义通用提示词引用 → MODE_FRAGMENT_IN_USE(409)，message 列出引用处。
   */
  async removeFragment(
    userId: string,
    fragmentId: string,
  ): Promise<{ id: string }> {
    if (isPromptFragmentId(fragmentId)) {
      throw invalidMessage('内置片段不能删除，只能恢复默认');
    }
    await this.findOwnedFragment(userId, fragmentId);
    const [modes, general] = await Promise.all([
      this.prisma.agentMode.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { name: true, systemPrompt: true },
      }),
      this.prisma.generalModeSetting.findUnique({
        where: { userId },
        select: { systemPrompt: true },
      }),
    ]);
    const refersTo = (text: string) =>
      findFragmentReferences(text).includes(fragmentId);
    const usedBy = modes
      .filter((m) => refersTo(m.systemPrompt))
      .map((m) => `模式 ${m.name}`);
    if (general?.systemPrompt != null && refersTo(general.systemPrompt)) {
      usedBy.push('通用模式');
    }
    if (usedBy.length) {
      throw new BusinessException(
        {
          ...ErrorCodes.MODE_FRAGMENT_IN_USE,
          message: `片段 ${fragmentId} 仍被使用：${usedBy.join('、')}`,
        },
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.customPromptFragment.delete({
      where: { userId_fragmentId: { userId, fragmentId } },
    });
    return { id: fragmentId };
  }

  /**
   * 改写一个内置片段（upsert）。text 为 null 或与默认正文相同 = 恢复默认（删行）；
   * 长度不合法 → MODE_INVALID；用了 {{skills_dir}} 以外的变量 → MODE_FRAGMENT_INVALID_VARIABLE。
   */
  private async updateBuiltinFragment(
    userId: string,
    fragmentId: PromptFragmentId,
    text: string | null,
  ): Promise<PromptFragmentView> {
    if (text === null || text === PROMPT_FRAGMENT_DEFAULTS[fragmentId]) {
      await this.prisma.promptFragmentOverride.deleteMany({
        where: { userId, fragmentId },
      });
      return toFragmentView(fragmentId, {});
    }
    const parsed = parseFragmentText(text);
    await this.prisma.promptFragmentOverride.upsert({
      where: { userId_fragmentId: { userId, fragmentId } },
      create: { userId, fragmentId, text: parsed },
      update: { text: parsed },
    });
    return toFragmentView(fragmentId, { [fragmentId]: parsed });
  }

  /** 该用户已有的自建片段；id 格式不对或不存在 → MODE_FRAGMENT_NOT_FOUND(404)。 */
  private async findOwnedFragment(userId: string, fragmentId: string) {
    const row = isCustomFragmentId(fragmentId)
      ? await this.prisma.customPromptFragment.findUnique({
          where: { userId_fragmentId: { userId, fragmentId } },
          select: { fragmentId: true },
        })
      : null;
    if (!row) {
      throw new BusinessException(
        ErrorCodes.MODE_FRAGMENT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * 该用户的自建片段（id → 正文，按创建时间；传给 resolveMode 的 customFragments，worker 装配与预览共用）。
   */
  async customFragments(userId: string): Promise<CustomFragments> {
    const rows = await this.prisma.customPromptFragment.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { fragmentId: true, text: true },
    });
    return Object.fromEntries(rows.map((r) => [r.fragmentId, r.text]));
  }

  /** 该用户的自建片段 id（按创建时间）：校验占位符时算「已知」，目录里追加在内置 id 之后。 */
  private async customFragmentIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.customPromptFragment.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { fragmentId: true },
    });
    return rows.map((r) => r.fragmentId);
  }

  /**
   * 该用户改写过的平台片段正文（传给 resolveMode 的 fragmentOverrides；worker 装配与预览共用）。
   * 片段集合以 core 为准：库里残留的未知 id 忽略。
   */
  async fragmentOverrides(userId: string): Promise<FragmentOverrides> {
    const rows = await this.prisma.promptFragmentOverride.findMany({
      where: { userId },
      select: { fragmentId: true, text: true },
    });
    const overrides: FragmentOverrides = {};
    for (const { fragmentId, text } of rows) {
      if (isPromptFragmentId(fragmentId)) overrides[fragmentId] = text;
    }
    return overrides;
  }

  /** 预览的共同部分：按该用户当前环境装配（mode 为 null = 通用模式，用 generalPrompt）。 */
  private async assemblePreview(
    userId: string,
    mode: AgentMode | null,
    generalPrompt: string | null,
    customFragments: CustomFragments,
  ): Promise<ModePreview> {
    const [installedSkills, mcpServers, env, fragmentOverrides] =
      await Promise.all([
        this.skills.effectiveSkillsFor(userId),
        this.mcp.runtimeServers(userId),
        this.environment(userId),
        this.fragmentOverrides(userId),
      ]);
    const assembly = resolveMode({
      mode,
      generalPrompt,
      fragmentOverrides,
      customFragments,
      registry: this.registry,
      env,
      installedSkills,
      mcpServers,
      envPromptBlock: backendEnvPromptBlock(env.workspace),
    });
    return {
      systemPrompt: assembly.systemPrompt,
      unavailable: assembly.unavailable,
    };
  }

  /**
   * 语义校验：core schema（去空白、长度、数组默认）+ 未知占位符拒绝（customIds：该用户的自建片段 id 算已知）。
   * 未知占位符的报错把 id 带给用户（「未知占位符：platform.nope」）。
   */
  private validate(
    input: ModeInputDto,
    customIds: readonly string[],
  ): AgentModeInput {
    const parsed = AgentModeInputSchema.safeParse(input);
    if (!parsed.success) throw invalidMode(parsed.error);
    assertKnownPlaceholders(parsed.data.systemPrompt, customIds);
    return parsed.data;
  }

  /** 通用模式设置的语义校验：同上（提示词为 null = 默认，不查占位符）。 */
  private validateGeneral(
    input: Partial<GeneralModeInputDto>,
    customIds: readonly string[],
  ): GeneralModeSettings {
    const parsed = GeneralModeSettingsSchema.safeParse(input);
    if (!parsed.success) throw invalidMode(parsed.error);
    if (parsed.data.systemPrompt !== null) {
      assertKnownPlaceholders(parsed.data.systemPrompt, customIds);
    }
    return parsed.data;
  }

  private async findOwned(userId: string, id: string) {
    const row = await this.prisma.agentMode.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new BusinessException(
        ErrorCodes.MODE_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * 该用户的运行环境：沙箱提供方配置了 key 即视为有沙箱（worker 会 find-or-create），
   * 路径按 /workspace 口径（GuardedSandbox.visibleRoot 正常就是它）。
   */
  private async environment(userId: string) {
    const { provider } = await this.sandboxSettings.resolve(userId);
    return backendEnvironment(
      isSandboxConfigured(provider)
        ? {
            visibleRoot: VISIBLE_WORKSPACE,
            skillsDir: `${VISIBLE_WORKSPACE}/skills`,
          }
        : null,
    );
  }
}

/** zod 校验失败 → MODE_INVALID，message 列出各字段的问题。 */
function invalidMode(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): BusinessException {
  return new BusinessException({
    ...ErrorCodes.MODE_INVALID,
    message: error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; '),
  });
}

/** 单字段 zod 校验失败 → MODE_INVALID，message 形如「id: …」。 */
function invalidFields(
  field: string,
  error: { issues: readonly { message: string }[] },
): BusinessException {
  return invalidMessage(
    error.issues.map((i) => `${field}: ${i.message}`).join('; '),
  );
}

function invalidMessage(message: string): BusinessException {
  return new BusinessException({ ...ErrorCodes.MODE_INVALID, message });
}

function parseTitle(title: string): string {
  const parsed = FragmentTitleSchema.safeParse(title);
  if (!parsed.success) throw invalidFields('title', parsed.error);
  return parsed.data;
}

/**
 * 片段正文（内置改写与自建共用）：长度不合法 → MODE_INVALID；
 * 用了 {{skills_dir}} 以外的变量（含片段占位符）→ MODE_FRAGMENT_INVALID_VARIABLE。
 */
function parseFragmentText(text: string): string {
  const parsed = FragmentTextSchema.safeParse(text);
  if (!parsed.success) throw invalidFields('text', parsed.error);
  const invalid = findInvalidFragmentVariables(parsed.data);
  if (invalid.length) {
    throw new BusinessException({
      ...ErrorCodes.MODE_FRAGMENT_INVALID_VARIABLE,
      message: `片段里只能使用 {{skills_dir}}，不支持：${invalid.join(', ')}`,
    });
  }
  return parsed.data;
}

/** 未知占位符 → MODE_INVALID_PLACEHOLDER，message 带上 id（「未知占位符：platform.nope」）。 */
function assertKnownPlaceholders(
  systemPrompt: string,
  customIds: readonly string[],
): void {
  const unknown = findUnknownPlaceholders(systemPrompt, customIds);
  if (unknown.length) {
    throw new BusinessException({
      ...ErrorCodes.MODE_INVALID_PLACEHOLDER,
      message: `未知占位符：${unknown.join(', ')}`,
    });
  }
}
