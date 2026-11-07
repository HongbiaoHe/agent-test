import {
  type AgentMode,
  type AgentModeInput,
  AgentModeInputSchema,
  GENERAL_MODE_PROMPT,
  type GeneralModeSettings,
  GeneralModeSettingsSchema,
} from '@agent-test/agent-core/modes/mode.schema';
import {
  findInvalidFragmentVariables,
  findUnknownPlaceholders,
  type FragmentOverrides,
  FragmentTextSchema,
  isPromptFragmentId,
  PROMPT_FRAGMENT_DEFAULTS,
  PROMPT_FRAGMENT_IDS,
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
  toFragmentView,
  toGeneralModeView,
  toModeView,
} from './mode-view';
import type {
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
    const data = this.validate(input);
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
    const data = this.validate(input);
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
    const [servers, skills, env] = await Promise.all([
      this.prisma.mcpServer.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, slug: true },
      }),
      this.skills.listFor(userId),
      this.environment(userId),
    ]);
    return {
      tools: this.registry.catalog(),
      mcpServers: servers,
      skills: skills
        .filter((s) => s.enabled)
        .map(({ name, description }) => ({ name, description })),
      fragments: [...PROMPT_FRAGMENT_IDS],
      generalPrompt: GENERAL_MODE_PROMPT,
      capabilities: [...env.capabilities],
    };
  }

  /** 按当前环境预览最终系统提示与不可用清单（纯装配，不建工具、不连 server）。 */
  async preview(userId: string, input: ModeInputDto): Promise<ModePreview> {
    const data = this.validate(input);
    return this.assemblePreview(userId, { id: 'preview', ...data }, null);
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
    const data = this.validateGeneral(input);
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
    const { systemPrompt } = this.validateGeneral({
      systemPrompt: input.systemPrompt,
    });
    return this.assemblePreview(userId, null, systemPrompt);
  }

  /** 平台片段列表（按 PROMPT_FRAGMENT_IDS 顺序）：生效正文 + 默认正文 + 是否改写过。 */
  async listFragments(userId: string): Promise<PromptFragmentView[]> {
    const overrides = await this.fragmentOverrides(userId);
    return PROMPT_FRAGMENT_IDS.map((id) => toFragmentView(id, overrides));
  }

  /**
   * 改写一个平台片段（upsert）。text 为 null 或与默认正文相同 = 恢复默认（删行）；
   * 未知片段 → 404；长度不合法 → MODE_INVALID；用了 {{skills_dir}} 以外的变量 → MODE_FRAGMENT_INVALID_VARIABLE。
   */
  async updateFragment(
    userId: string,
    fragmentId: string,
    input: FragmentInputDto,
  ): Promise<PromptFragmentView> {
    if (!isPromptFragmentId(fragmentId)) {
      throw new BusinessException(
        ErrorCodes.MODE_FRAGMENT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const { text } = input;
    if (text === null || text === PROMPT_FRAGMENT_DEFAULTS[fragmentId]) {
      await this.prisma.promptFragmentOverride.deleteMany({
        where: { userId, fragmentId },
      });
      return toFragmentView(fragmentId, {});
    }
    const parsed = FragmentTextSchema.safeParse(text);
    if (!parsed.success) {
      throw new BusinessException({
        ...ErrorCodes.MODE_INVALID,
        message: parsed.error.issues
          .map((i) => `text: ${i.message}`)
          .join('; '),
      });
    }
    const invalid = findInvalidFragmentVariables(parsed.data);
    if (invalid.length) {
      throw new BusinessException({
        ...ErrorCodes.MODE_FRAGMENT_INVALID_VARIABLE,
        message: `片段里只能使用 {{skills_dir}}，不支持：${invalid.join(', ')}`,
      });
    }
    await this.prisma.promptFragmentOverride.upsert({
      where: { userId_fragmentId: { userId, fragmentId } },
      create: { userId, fragmentId, text: parsed.data },
      update: { text: parsed.data },
    });
    return toFragmentView(fragmentId, { [fragmentId]: parsed.data });
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
   * 语义校验：core schema（去空白、长度、数组默认）+ 未知占位符拒绝。
   * 未知占位符的报错把 id 带给用户（「未知占位符：platform.nope」）。
   */
  private validate(input: ModeInputDto): AgentModeInput {
    const parsed = AgentModeInputSchema.safeParse(input);
    if (!parsed.success) throw invalidMode(parsed.error);
    assertKnownPlaceholders(parsed.data.systemPrompt);
    return parsed.data;
  }

  /** 通用模式设置的语义校验：同上（提示词为 null = 默认，不查占位符）。 */
  private validateGeneral(
    input: Partial<GeneralModeInputDto>,
  ): GeneralModeSettings {
    const parsed = GeneralModeSettingsSchema.safeParse(input);
    if (!parsed.success) throw invalidMode(parsed.error);
    if (parsed.data.systemPrompt !== null) {
      assertKnownPlaceholders(parsed.data.systemPrompt);
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

/** 未知占位符 → MODE_INVALID_PLACEHOLDER，message 带上 id（「未知占位符：platform.nope」）。 */
function assertKnownPlaceholders(systemPrompt: string): void {
  const unknown = findUnknownPlaceholders(systemPrompt);
  if (unknown.length) {
    throw new BusinessException({
      ...ErrorCodes.MODE_INVALID_PLACEHOLDER,
      message: `未知占位符：${unknown.join(', ')}`,
    });
  }
}
