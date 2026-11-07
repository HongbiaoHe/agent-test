// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；偏好已整体 mock，不需要真实提供方
jest.mock('../agent/sandbox-providers', () => ({}));
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GENERAL_MODE_PROMPT } from '@agent-test/agent-core/modes/mode.schema';
import { PROMPT_FRAGMENT_DEFAULTS } from '@agent-test/agent-core/modes/prompt-fragments';
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
      id: 'platform.language',
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
      id: 'platform.language',
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
      id: 'platform.language',
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
