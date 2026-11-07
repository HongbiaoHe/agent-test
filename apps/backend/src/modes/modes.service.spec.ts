// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；偏好已整体 mock，不需要真实提供方
jest.mock('../agent/sandbox-providers', () => ({}));
import { tool } from '@langchain/core/tools';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
import {
  isPromptFragmentId,
  PROMPT_FRAGMENT_DEFAULTS,
} from '@agent-test/agent-core/modes/prompt-fragments';
import { ToolRegistry } from '@agent-test/agent-core/modes/tool-registry';
import { isSandboxConfigured } from '../agent/sandbox';
import type { BackendHost } from '../agent/tool-registry.provider';
import { ErrorCodes } from '../common/errors/error-code';
import type { McpService } from '../mcp/mcp.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import type { SkillsService } from '../skills/skills.service';
import { ModesService } from './modes.service';

jest.mock('../agent/sandbox', () => ({
  isSandboxConfigured: jest.fn(() => false),
  VISIBLE_WORKSPACE: '/workspace',
}));

const mk = (name: string) =>
  tool(() => name, { name, description: name, schema: z.object({}) });

/** 两把工具：一把只要固有能力，一把要沙箱（无沙箱时降级） */
function makeRegistry() {
  return new ToolRegistry<BackendHost>()
    .register({
      name: 'gen',
      title: '生图',
      description: 'g',
      requires: ['media_api'],
      promptSection: '## 生图段',
      create: () => mk('gen'),
    })
    .register({
      name: 'preview_page',
      title: '预览',
      description: 'p',
      requires: ['sandbox'],
      create: () => mk('preview_page'),
    });
}

const now = new Date('2026-11-06T00:00:00Z');

/** customPromptFragment 行（mock 里 findMany 按 select 返回其子集即可） */
interface CustomRow {
  userId: string;
  fragmentId: string;
  title: string;
  text: string;
}
const row = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  userId: 'u1',
  name: '生图',
  systemPrompt: 'x',
  toolNames: ['gen'],
  mcpServerIds: [],
  skillNames: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  createdAt: now,
  updatedAt: now,
  ...extra,
});

function makeService() {
  const prisma = {
    agentMode: {
      findMany: jest.fn().mockResolvedValue([row()]),
      findFirst: jest.fn().mockResolvedValue(row()),
      create: jest.fn((arg: { data: Record<string, unknown> }) =>
        Promise.resolve(row(arg.data)),
      ),
      update: jest.fn((arg: { data: Record<string, unknown> }) =>
        Promise.resolve(row(arg.data)),
      ),
      delete: jest.fn().mockResolvedValue(row()),
    },
    conversation: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    generalModeSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((arg: { create: Record<string, unknown> }) =>
        Promise.resolve({ updatedAt: now, ...arg.create }),
      ),
    },
    promptFragmentOverride: {
      findMany: jest
        .fn<Promise<{ fragmentId: string; text: string }[]>, []>()
        .mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customPromptFragment: {
      findMany: jest
        .fn<Promise<CustomRow[]>, [{ select?: Record<string, boolean> }]>()
        .mockResolvedValue([]),
      findUnique: jest
        .fn<Promise<{ fragmentId: string } | null>, []>()
        .mockResolvedValue(null),
      create: jest.fn((arg: { data: CustomRow }) =>
        Promise.resolve({ ...arg.data, createdAt: now, updatedAt: now }),
      ),
      update: jest.fn(
        (arg: {
          where: { userId_fragmentId: { fragmentId: string } };
          data: Partial<CustomRow>;
        }) =>
          Promise.resolve({
            userId: 'u1',
            fragmentId: arg.where.userId_fragmentId.fragmentId,
            title: '旧标题',
            text: '旧正文',
            ...arg.data,
            createdAt: now,
            updatedAt: now,
          }),
      ),
      delete: jest.fn().mockResolvedValue({}),
    },
    mcpServer: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 's1', name: 'Buzz', slug: 'buzz' }]),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const skills = {
    listFor: jest.fn().mockResolvedValue([
      { name: 'tvc', description: 'TVC', enabled: true },
      { name: 'off', description: '已禁用', enabled: false },
    ]),
    effectiveSkillsFor: jest
      .fn()
      .mockResolvedValue([{ name: 'tvc', files: { 'SKILL.md': '# tvc' } }]),
  };
  const mcp = { runtimeServers: jest.fn().mockResolvedValue([]) };
  const sandboxSettings = {
    resolve: jest.fn().mockResolvedValue({ provider: 'daytona' }),
  };
  const service = new ModesService(
    prisma as unknown as PrismaService,
    makeRegistry(),
    skills as unknown as SkillsService,
    mcp as unknown as McpService,
    sandboxSettings as unknown as SandboxSettingsService,
  );
  return { service, prisma, skills, mcp };
}

describe('ModesService CRUD', () => {
  it('create：经 schema 校验（name 去空白、数组默认空）后落库，返回不含 userId 的视图', async () => {
    const { service, prisma } = makeService();
    const view = await service.create('u1', {
      name: ' 生图 ',
      systemPrompt: 'x',
    });
    expect(prisma.agentMode.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        name: '生图',
        systemPrompt: 'x',
        toolNames: [],
        mcpServerIds: [],
        skillNames: [],
        defaultModel: null,
        defaultThinkingLevel: null,
      },
    });
    expect(view).not.toHaveProperty('userId');
    expect(view).toMatchObject({ id: 'm1', name: '生图', createdAt: now });
  });

  it('create：未知占位符 → MODE_INVALID_PLACEHOLDER，message 列出 id', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.create('u1', {
        name: 'a',
        systemPrompt: '{{platform.nope}} {{platform.language}}',
      }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
      message: '未知占位符：platform.nope',
    });
    expect(prisma.agentMode.create).not.toHaveBeenCalled();
  });

  it('create：name 空 → MODE_INVALID（400）', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { name: '   ', systemPrompt: 'x' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
  });

  it('update：不属于该用户 → MODE_NOT_FOUND(404)，不写库', async () => {
    const { service, prisma } = makeService();
    prisma.agentMode.findFirst.mockResolvedValue(null);
    await expect(
      service.update('u2', 'm1', { name: 'a', systemPrompt: 'x' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.MODE_NOT_FOUND.code });
    expect(prisma.agentMode.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1', userId: 'u2' },
    });
    expect(prisma.agentMode.update).not.toHaveBeenCalled();
  });

  it('update：属于该用户 → 整体更新', async () => {
    const { service, prisma } = makeService();
    await service.update('u1', 'm1', {
      name: 'b',
      systemPrompt: 'y',
      toolNames: ['gen'],
      defaultModel: 'deepseek:deepseek-flash',
    });
    expect(prisma.agentMode.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        name: 'b',
        systemPrompt: 'y',
        toolNames: ['gen'],
        defaultModel: 'deepseek:deepseek-flash',
      }),
    });
  });

  it('remove：事务里先把引用它的会话 modeId 置空，再删行', async () => {
    const { service, prisma } = makeService();
    expect(await service.remove('u1', 'm1')).toEqual({ id: 'm1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', modeId: 'm1' },
      data: { modeId: null },
    });
    expect(prisma.agentMode.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
  });
});

describe('ModesService catalog / preview', () => {
  it('catalog：工具目录 + server + 已启用技能 + 片段 id + 通用提示词 + 当前能力（无沙箱）', async () => {
    const { service } = makeService();
    const c = await service.catalog('u1');
    expect(c.tools).toEqual([
      { name: 'gen', title: '生图', description: 'g', requires: ['media_api'] },
      {
        name: 'preview_page',
        title: '预览',
        description: 'p',
        requires: ['sandbox'],
      },
    ]);
    expect(c.mcpServers).toEqual([{ id: 's1', name: 'Buzz', slug: 'buzz' }]);
    // 禁用的技能不进目录
    expect(c.skills).toEqual([{ name: 'tvc', description: 'TVC' }]);
    expect(c.fragments).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
    ]);
    expect(c.generalPrompt).toBe(GENERAL_MODE_PROMPT);
    expect([...c.capabilities].sort()).toEqual([
      'background',
      'email',
      'media_api',
    ]);
  });

  it('catalog：沙箱提供方已配置 → 能力含 sandbox / workspace / workspace_write', async () => {
    (isSandboxConfigured as jest.Mock).mockReturnValueOnce(true);
    const { service } = makeService();
    const c = await service.catalog('u1');
    expect(c.capabilities).toEqual(
      expect.arrayContaining(['sandbox', 'workspace', 'workspace_write']),
    );
    expect(isSandboxConfigured).toHaveBeenCalledWith('daytona');
  });

  it('preview：按当前环境装配，返回最终提示词与不可用清单（无沙箱 → preview_page 降级）', async () => {
    const { service, prisma } = makeService();
    const p = await service.preview('u1', {
      name: 'a',
      systemPrompt: '专用 {{platform.language}}',
      toolNames: ['gen', 'preview_page', 'ghost'],
      skillNames: ['tvc', 'nope'],
      mcpServerIds: ['sX'],
    });
    expect(p.systemPrompt.startsWith('专用 ## 回复语言')).toBe(true);
    expect(p.systemPrompt).toContain('## 生图段');
    expect(p.systemPrompt).toContain('## 用户上传的附件');
    expect(p.systemPrompt).not.toContain('## 工作区与沙箱执行');
    expect(p.systemPrompt).toContain('`preview_page`');
    expect(p.unavailable).toEqual(
      expect.arrayContaining([
        { kind: 'tool', name: 'ghost', reason: 'not_registered' },
        {
          kind: 'tool',
          name: 'preview_page',
          reason: 'missing_capability:sandbox',
        },
        { kind: 'mcp_server', name: 'sX', reason: 'not_found' },
        { kind: 'skill', name: 'nope', reason: 'not_installed' },
      ]),
    );
    // 预览不落库
    expect(prisma.agentMode.create).not.toHaveBeenCalled();
  });

  it('preview：未知占位符同样拒绝', async () => {
    const { service } = makeService();
    await expect(
      service.preview('u1', { name: 'a', systemPrompt: '{{platform.nope}}' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
    });
  });
});

describe('ModesService 通用模式设置', () => {
  it('get：没有行 → 全默认（生效提示词 = 默认提示词，isCustom false）', async () => {
    const { service, prisma } = makeService();
    expect(await service.getGeneral('u1')).toEqual({
      systemPrompt: GENERAL_MODE_PROMPT,
      isCustom: false,
      defaultPrompt: GENERAL_MODE_PROMPT,
      defaultModel: null,
      defaultThinkingLevel: null,
    });
    expect(prisma.generalModeSetting.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });

  it('get：有自定义提示词 → 返回它，isCustom true，defaultPrompt 仍是默认', async () => {
    const { service, prisma } = makeService();
    prisma.generalModeSetting.findUnique.mockResolvedValue({
      userId: 'u1',
      systemPrompt: '自定义',
      defaultModel: 'deepseek:deepseek-flash',
      defaultThinkingLevel: 'high',
      updatedAt: now,
    });
    expect(await service.getGeneral('u1')).toEqual({
      systemPrompt: '自定义',
      isCustom: true,
      defaultPrompt: GENERAL_MODE_PROMPT,
      defaultModel: 'deepseek:deepseek-flash',
      defaultThinkingLevel: 'high',
    });
  });

  it('put：按 userId upsert 整体替换，返回生效视图', async () => {
    const { service, prisma } = makeService();
    const view = await service.updateGeneral('u1', {
      systemPrompt: '我的 {{platform.language}}',
      defaultModel: 'deepseek:deepseek-flash',
      defaultThinkingLevel: 'high',
    });
    const data = {
      systemPrompt: '我的 {{platform.language}}',
      defaultModel: 'deepseek:deepseek-flash',
      defaultThinkingLevel: 'high',
    };
    expect(prisma.generalModeSetting.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      create: { userId: 'u1', ...data },
      update: data,
    });
    expect(view).toEqual({
      ...data,
      isCustom: true,
      defaultPrompt: GENERAL_MODE_PROMPT,
    });
  });

  it('put：systemPrompt null = 恢复默认（存 NULL），缺省的模型 / 档位按 null 存', async () => {
    const { service, prisma } = makeService();
    const view = await service.updateGeneral('u1', { systemPrompt: null });
    expect(prisma.generalModeSetting.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      create: {
        userId: 'u1',
        systemPrompt: null,
        defaultModel: null,
        defaultThinkingLevel: null,
      },
      update: {
        systemPrompt: null,
        defaultModel: null,
        defaultThinkingLevel: null,
      },
    });
    expect(view).toMatchObject({
      systemPrompt: GENERAL_MODE_PROMPT,
      isCustom: false,
    });
  });

  it('put：未知占位符 → MODE_INVALID_PLACEHOLDER（「未知占位符：…」），不写库', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.updateGeneral('u1', {
        systemPrompt: '{{platform.nope}} {{platform.language}}',
      }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
      message: '未知占位符：platform.nope',
    });
    expect(prisma.generalModeSetting.upsert).not.toHaveBeenCalled();
  });

  it('put：空提示词 → MODE_INVALID（要恢复默认请传 null）', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.updateGeneral('u1', { systemPrompt: '' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
    expect(prisma.generalModeSetting.upsert).not.toHaveBeenCalled();
  });

  it('preview：工具 / 技能取全集，提示词用传入的；null → 默认提示词', async () => {
    const { service, prisma } = makeService();
    const custom = await service.previewGeneral('u1', {
      systemPrompt: '我的 {{platform.language}}',
    });
    expect(custom.systemPrompt.startsWith('我的 ## 回复语言')).toBe(true);
    // 通用模式：注册表全部工具参与装配（gen 的 promptSection 在内，无沙箱 preview_page 降级）
    expect(custom.systemPrompt).toContain('## 生图段');
    expect(custom.unavailable).toEqual([
      {
        kind: 'tool',
        name: 'preview_page',
        reason: 'missing_capability:sandbox',
      },
    ]);
    const def = await service.previewGeneral('u1', { systemPrompt: null });
    expect(def.systemPrompt.startsWith('你是 Spark')).toBe(true);
    expect(prisma.generalModeSetting.upsert).not.toHaveBeenCalled();
  });

  it('preview：未知占位符同样拒绝', async () => {
    const { service } = makeService();
    await expect(
      service.previewGeneral('u1', { systemPrompt: '{{platform.nope}}' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
    });
  });
});

describe('ModesService 平台片段', () => {
  const LANG = PROMPT_FRAGMENT_DEFAULTS['platform.language'];

  it('list：没有改写 → 4 个片段按固定顺序，正文 = 默认，isCustom 全为 false', async () => {
    const { service, prisma } = makeService();
    const list = await service.listFragments('u1');
    expect(list.map((f) => f.id)).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
    ]);
    for (const f of list) {
      if (!isPromptFragmentId(f.id)) throw new Error(`unexpected ${f.id}`);
      expect(f.kind).toBe('builtin');
      expect(f.title).toBeNull();
      expect(f.isCustom).toBe(false);
      expect(f.text).toBe(PROMPT_FRAGMENT_DEFAULTS[f.id]);
      expect(f.defaultText).toBe(PROMPT_FRAGMENT_DEFAULTS[f.id]);
    }
    expect(prisma.promptFragmentOverride.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { fragmentId: true, text: true },
    });
  });

  it('list：有改写 → 该片段返回改写正文、isCustom true，defaultText 仍是默认；残留的未知 id 忽略', async () => {
    const { service, prisma } = makeService();
    prisma.promptFragmentOverride.findMany.mockResolvedValue([
      { fragmentId: 'platform.language', text: '只说英文' },
      { fragmentId: 'platform.retired', text: '旧' },
    ]);
    const list = await service.listFragments('u1');
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({
      kind: 'builtin',
      id: 'platform.language',
      title: null,
      text: '只说英文',
      defaultText: LANG,
      isCustom: true,
    });
    expect(list.slice(1).every((f) => !f.isCustom)).toBe(true);
  });

  it('update：改写 → 按 (userId, fragmentId) upsert，返回改写后的视图（{{skills_dir}} 允许）', async () => {
    const { service, prisma } = makeService();
    const text = '技能在 {{skills_dir}} 下';
    const view = await service.updateFragment('u1', 'platform.language', {
      text,
    });
    expect(prisma.promptFragmentOverride.upsert).toHaveBeenCalledWith({
      where: {
        userId_fragmentId: { userId: 'u1', fragmentId: 'platform.language' },
      },
      create: { userId: 'u1', fragmentId: 'platform.language', text },
      update: { text },
    });
    expect(view).toEqual({
      kind: 'builtin',
      id: 'platform.language',
      title: null,
      text,
      defaultText: LANG,
      isCustom: true,
    });
  });

  it.each([
    ['null', null],
    ['与默认正文相同', LANG],
  ])('update：text 为 %s → 恢复默认（删行，不 upsert）', async (_, text) => {
    const { service, prisma } = makeService();
    const view = await service.updateFragment('u1', 'platform.language', {
      text,
    });
    expect(prisma.promptFragmentOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', fragmentId: 'platform.language' },
    });
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
    expect(view).toEqual({
      kind: 'builtin',
      id: 'platform.language',
      title: null,
      text: LANG,
      defaultText: LANG,
      isCustom: false,
    });
  });

  it('update：{{skills_dir}} 以外的变量（含片段占位符）→ MODE_FRAGMENT_INVALID_VARIABLE(400)，不写库', async () => {
    const { service, prisma } = makeService();
    const err = await service
      .updateFragment('u1', 'platform.language', {
        text: '{{foo}} {{skills_dir}} {{platform.slash_command}} {{foo}}',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_INVALID_VARIABLE.code,
      message:
        '片段里只能使用 {{skills_dir}}，不支持：foo, platform.slash_command',
    });
    expect(err).toHaveProperty('status', 400);
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
    expect(prisma.promptFragmentOverride.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ['空串', ''],
    ['超过 20000 字', 'x'.repeat(20_001)],
  ])('update：%s → MODE_INVALID(400)，不写库', async (_, text) => {
    const { service, prisma } = makeService();
    const err = await service
      .updateFragment('u1', 'platform.language', { text })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
    expect(err).toHaveProperty('status', 400);
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
  });

  it('update：未知片段 id → MODE_FRAGMENT_NOT_FOUND(404)，不写库（不能新增片段）', async () => {
    const { service, prisma } = makeService();
    const err = await service
      .updateFragment('u1', 'platform.custom', { text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_NOT_FOUND.code,
    });
    expect(err).toHaveProperty('status', 404);
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
    expect(prisma.promptFragmentOverride.deleteMany).not.toHaveBeenCalled();
  });

  it('preview / general preview：用该用户的片段改写展开占位符，{{skills_dir}} 换成实际路径', async () => {
    const { service, prisma } = makeService();
    prisma.promptFragmentOverride.findMany.mockResolvedValue([
      {
        fragmentId: 'platform.language',
        text: '只说英文，技能在 {{skills_dir}}',
      },
    ]);
    const mode = await service.preview('u1', {
      name: 'a',
      systemPrompt: '专用 {{platform.language}}',
    });
    // 无沙箱 → 技能目录 /skills
    expect(mode.systemPrompt.startsWith('专用 只说英文，技能在 /skills')).toBe(
      true,
    );
    const general = await service.previewGeneral('u1', {
      systemPrompt: '通用 {{platform.language}}',
    });
    expect(
      general.systemPrompt.startsWith('通用 只说英文，技能在 /skills'),
    ).toBe(true);
    expect(general.systemPrompt).not.toContain('{{skills_dir}}');
    expect(general.systemPrompt).not.toContain('## 回复语言');
  });
});

describe('ModesService 自建片段', () => {
  /** 该用户已有一个自建片段 custom.tone（findMany 按 select 返回需要的列） */
  function withTone(prisma: ReturnType<typeof makeService>['prisma']) {
    const tone: CustomRow = {
      userId: 'u1',
      fragmentId: 'custom.tone',
      title: '语气',
      text: '语气友好，技能在 {{skills_dir}}',
    };
    prisma.customPromptFragment.findMany.mockResolvedValue([tone]);
    prisma.customPromptFragment.findUnique.mockResolvedValue({
      fragmentId: 'custom.tone',
    });
    return tone;
  }

  it('list：内置 4 个在前，自建片段按创建时间在后（kind custom、有 title、defaultText null、isCustom false）', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    const list = await service.listFragments('u1');
    expect(list.map((f) => f.id)).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
      'custom.tone',
    ]);
    expect(list[4]).toEqual({
      kind: 'custom',
      id: 'custom.tone',
      title: '语气',
      text: '语气友好，技能在 {{skills_dir}}',
      defaultText: null,
      isCustom: false,
    });
    expect(prisma.customPromptFragment.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
      select: { fragmentId: true, title: true, text: true },
    });
  });

  it('create：合法 → 落库（title 去空白），返回自建片段视图', async () => {
    const { service, prisma } = makeService();
    const view = await service.createFragment('u1', {
      id: 'custom.tone_2',
      title: '  语气  ',
      text: '技能在 {{skills_dir}}',
    });
    expect(prisma.customPromptFragment.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        fragmentId: 'custom.tone_2',
        title: '语气',
        text: '技能在 {{skills_dir}}',
      },
    });
    expect(view).toEqual({
      kind: 'custom',
      id: 'custom.tone_2',
      title: '语气',
      text: '技能在 {{skills_dir}}',
      defaultText: null,
      isCustom: false,
    });
  });

  it.each([
    ['大写与连字符', 'custom.Bad-Id'],
    ['没有前缀', 'tone'],
    ['名字为空', 'custom.'],
    ['超过 48 位', `custom.${'a'.repeat(49)}`],
    ['冒充内置前缀', 'platform.tone'],
  ])(
    'create：id %s → MODE_INVALID(400)，message 用 core 文案，不写库',
    async (_, id) => {
      const { service, prisma } = makeService();
      const err = await service
        .createFragment('u1', { id, title: 't', text: 'x' })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        errCode: ErrorCodes.MODE_INVALID.code,
        message: 'id: id 格式为 custom.<小写字母、数字、下划线，1～48 位>',
      });
      expect(err).toHaveProperty('status', 400);
      expect(prisma.customPromptFragment.create).not.toHaveBeenCalled();
    },
  );

  it('create：title 空白 → MODE_INVALID(400)', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.createFragment('u1', { id: 'custom.a', title: '  ', text: 'x' }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
    expect(prisma.customPromptFragment.create).not.toHaveBeenCalled();
  });

  it('create：id 已存在（唯一键冲突）→ MODE_FRAGMENT_EXISTS(409)「片段 custom.tone 已存在」', async () => {
    const { service, prisma } = makeService();
    prisma.customPromptFragment.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const err = await service
      .createFragment('u1', { id: 'custom.tone', title: 't', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_EXISTS.code,
      message: '片段 custom.tone 已存在',
    });
    expect(err).toHaveProperty('status', 409);
  });

  it('create：{{skills_dir}} 以外的变量（含片段占位符）→ MODE_FRAGMENT_INVALID_VARIABLE(400)，不写库', async () => {
    const { service, prisma } = makeService();
    const err = await service
      .createFragment('u1', {
        id: 'custom.a',
        title: 't',
        text: '{{custom.b}} {{skills_dir}} {{platform.language}}',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_INVALID_VARIABLE.code,
      message:
        '片段里只能使用 {{skills_dir}}，不支持：custom.b, platform.language',
    });
    expect(err).toHaveProperty('status', 400);
    expect(prisma.customPromptFragment.create).not.toHaveBeenCalled();
  });

  it('update：只改 title / 只改 text → 只更新给出的字段', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    const titled = await service.updateFragment('u1', 'custom.tone', {
      title: ' 新标题 ',
    });
    expect(prisma.customPromptFragment.update).toHaveBeenLastCalledWith({
      where: { userId_fragmentId: { userId: 'u1', fragmentId: 'custom.tone' } },
      data: { title: '新标题' },
    });
    expect(titled).toMatchObject({ kind: 'custom', title: '新标题' });

    const texted = await service.updateFragment('u1', 'custom.tone', {
      text: '新正文 {{skills_dir}}',
    });
    expect(prisma.customPromptFragment.update).toHaveBeenLastCalledWith({
      where: { userId_fragmentId: { userId: 'u1', fragmentId: 'custom.tone' } },
      data: { text: '新正文 {{skills_dir}}' },
    });
    expect(texted).toMatchObject({ text: '新正文 {{skills_dir}}' });
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['text: null（没有默认可恢复）', { text: null }],
    ['title 与 text 都没给', {}],
    ['非法变量', { text: '{{foo}}' }],
  ])('update：%s → 400，不写库', async (_, body) => {
    const { service, prisma } = makeService();
    withTone(prisma);
    const err = await service
      .updateFragment('u1', 'custom.tone', body)
      .catch((e: unknown) => e);
    expect(err).toHaveProperty('status', 400);
    expect(prisma.customPromptFragment.update).not.toHaveBeenCalled();
  });

  it('update：自建片段不存在 → MODE_FRAGMENT_NOT_FOUND(404)', async () => {
    const { service, prisma } = makeService();
    const err = await service
      .updateFragment('u1', 'custom.ghost', { text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_NOT_FOUND.code,
    });
    expect(err).toHaveProperty('status', 404);
    expect(prisma.customPromptFragment.update).not.toHaveBeenCalled();
  });

  it('update：内置片段带 title 或缺 text → MODE_INVALID(400)', async () => {
    const { service, prisma } = makeService();
    for (const body of [{ title: 't', text: 'x' }, {}]) {
      await expect(
        service.updateFragment('u1', 'platform.language', body),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
    }
    expect(prisma.promptFragmentOverride.upsert).not.toHaveBeenCalled();
  });

  it('remove：没被引用 → 删行，返回 { id }', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    prisma.agentMode.findMany.mockResolvedValue([
      row({ systemPrompt: '{{custom.tone2}} {{platform.language}}' }),
    ]);
    prisma.generalModeSetting.findUnique.mockResolvedValue({
      userId: 'u1',
      systemPrompt: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      updatedAt: now,
    });
    expect(await service.removeFragment('u1', 'custom.tone')).toEqual({
      id: 'custom.tone',
    });
    expect(prisma.customPromptFragment.delete).toHaveBeenCalledWith({
      where: { userId_fragmentId: { userId: 'u1', fragmentId: 'custom.tone' } },
    });
  });

  it('remove：被模式引用 → MODE_FRAGMENT_IN_USE(409)，message 列出模式名，不删', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    prisma.agentMode.findMany.mockResolvedValue([
      row({ name: 'A', systemPrompt: '前 {{ custom.tone }} 后' }),
      row({ name: '无关', systemPrompt: '{{platform.language}}' }),
      row({ name: 'B', systemPrompt: '{{custom.tone}}' }),
    ]);
    const err = await service
      .removeFragment('u1', 'custom.tone')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_IN_USE.code,
      message: '片段 custom.tone 仍被使用：模式 A、模式 B',
    });
    expect(err).toHaveProperty('status', 409);
    expect(prisma.agentMode.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
      select: { name: true, systemPrompt: true },
    });
    expect(prisma.customPromptFragment.delete).not.toHaveBeenCalled();
  });

  it('remove：被自定义通用提示词引用 → MODE_FRAGMENT_IN_USE(409)，message 含「通用模式」', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    prisma.agentMode.findMany.mockResolvedValue([]);
    prisma.generalModeSetting.findUnique.mockResolvedValue({
      userId: 'u1',
      systemPrompt: '通用 {{custom.tone}}',
      defaultModel: null,
      defaultThinkingLevel: null,
      updatedAt: now,
    });
    await expect(
      service.removeFragment('u1', 'custom.tone'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_FRAGMENT_IN_USE.code,
      message: '片段 custom.tone 仍被使用：通用模式',
    });
    expect(prisma.customPromptFragment.delete).not.toHaveBeenCalled();
  });

  it('remove：内置片段 → MODE_INVALID(400)；不存在的自建片段 → 404', async () => {
    const { service, prisma } = makeService();
    const builtin = await service
      .removeFragment('u1', 'platform.language')
      .catch((e: unknown) => e);
    expect(builtin).toMatchObject({ errCode: ErrorCodes.MODE_INVALID.code });
    expect(builtin).toHaveProperty('status', 400);
    const ghost = await service
      .removeFragment('u1', 'custom.ghost')
      .catch((e: unknown) => e);
    expect(ghost).toHaveProperty('status', 404);
    expect(prisma.customPromptFragment.delete).not.toHaveBeenCalled();
    expect(prisma.promptFragmentOverride.deleteMany).not.toHaveBeenCalled();
  });

  it('模式 create / 通用 put：引用已有自建片段可保存；引用不存在的自建片段 → MODE_INVALID_PLACEHOLDER', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    await service.create('u1', { name: 'a', systemPrompt: '{{custom.tone}}' });
    expect(prisma.agentMode.create).toHaveBeenCalledTimes(1);
    await service.updateGeneral('u1', { systemPrompt: '{{custom.tone}}' });
    expect(prisma.generalModeSetting.upsert).toHaveBeenCalledTimes(1);

    await expect(
      service.create('u1', {
        name: 'a',
        systemPrompt: '{{custom.tone}} {{custom.ghost}}',
      }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
      message: '未知占位符：custom.ghost',
    });
    await expect(
      service.updateGeneral('u1', { systemPrompt: '{{custom.ghost}}' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
    });
    expect(prisma.agentMode.create).toHaveBeenCalledTimes(1);
    expect(prisma.generalModeSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('catalog：fragments 在内置 id 后追加该用户的自建 id', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    const c = await service.catalog('u1');
    expect(c.fragments).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
      'custom.tone',
    ]);
  });

  it('preview / general preview：展开自建片段，{{skills_dir}} 换成实际路径', async () => {
    const { service, prisma } = makeService();
    withTone(prisma);
    const mode = await service.preview('u1', {
      name: 'a',
      systemPrompt: '专用 {{custom.tone}}',
    });
    expect(mode.systemPrompt.startsWith('专用 语气友好，技能在 /skills')).toBe(
      true,
    );
    const general = await service.previewGeneral('u1', {
      systemPrompt: '通用 {{custom.tone}}',
    });
    expect(
      general.systemPrompt.startsWith('通用 语气友好，技能在 /skills'),
    ).toBe(true);
    await expect(
      service.preview('u1', { name: 'a', systemPrompt: '{{custom.ghost}}' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MODE_INVALID_PLACEHOLDER.code,
    });
  });
});
