import { InMemoryStore } from '@langchain/langgraph';
import {
  AIMessageChunk,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { Job, Queue } from 'bullmq';
import { buildAgent } from '../agent/agent.factory';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { createMediaTools } from '../media/media.tools';
import { PrismaService } from '../prisma/prisma.service';
import { seedSkillsStore } from '../skills/skill-store.seed';
import type { SkillDef } from '../skills/skills.service';
import { SkillsService } from '../skills/skills.service';
import { AbortRegistry } from '../agent/abort-registry';
import { AgentProcessor } from './agent.processor';

// 避免加载 deepagents / google-genai 等重依赖，并能捕获传给 agent 的 input
jest.mock('../agent/agent.factory', () => ({ buildAgent: jest.fn() }));

// getUserSandbox 是模块级函数，需 jest.mock 拦截，否则会真的调 Daytona SDK
jest.mock('../agent/sandbox', () => ({
  getUserSandbox: jest.fn().mockResolvedValue(null),
  findUserSandbox: jest.fn().mockResolvedValue(null),
}));

// seedSkillsStore spy：验证 run 前确实调了播种，且入参正确
jest.mock('../skills/skill-store.seed', () => ({
  seedSkillsStore: jest.fn().mockResolvedValue(undefined),
}));

// createMediaTools mock：拦截媒体工具构造，避免依赖真实 MediaService
jest.mock('../media/media.tools', () => ({
  createMediaTools: jest
    .fn()
    .mockReturnValue([{ name: 'generate_image' }, { name: 'generate_video' }]),
}));

/** 构造 MediaService mock（仅需 createGeneration 和 listForConversation 存在） */
const makeMediaService = (generations: unknown[] = []) =>
  ({
    createGeneration: jest.fn(),
    listForConversation: jest.fn().mockResolvedValue(generations),
  }) as unknown as MediaService;

/** 构造 conv 记录（userId 固定为 'u1'，model 可选） */
const makeConv = (extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  userId: 'u1',
  model: null,
  status: 'running',
  ...extra,
});

describe('AgentProcessor 多轮重放', () => {
  it('重放历史时原样传递用户的 /command 消息，不注入 read_file/请使用技能 祈使（否则每轮重复触发同一技能、重复 read_file 同一文件）', async () => {
    const def: SkillDef = {
      name: 'tvc-director',
      description: '',
      kind: 'builtin' as const,
      source: 'builtin',
      enabled: true,
      files: { 'SKILL.md': '# tvc' },
    };

    // 第 1 轮是 /command，第 2 轮是普通追问 —— 模拟多轮续跑时的全量历史
    const history = [
      {
        role: 'user',
        content: { text: '/tvc-director 帮我做一条30秒手表广告' },
      },
      { role: 'assistant', content: { text: '（上一轮的分镜结果）' } },
      { role: 'user', content: { text: '再短一点，改成15秒' } },
    ];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([def]),
      getFor: jest.fn(async (_userId: string, name: string) =>
        name === 'tvc-director' ? def : undefined,
      ),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    // 捕获传给 agent.stream 的 input，断言其中的 messages 未被改写
    let captured: { messages: { role: string; content: string }[] } | undefined;
    const fakeAgent = {
      stream: jest.fn(async (input: typeof captured) => {
        captured = input;
        return (async function* () {})();
      }),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'c1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    const sent = captured!.messages;
    const userContents = sent
      .filter((m) => m.role === 'user')
      .map((m) => m.content);

    // 原始 /command 文本原样保留
    expect(userContents).toContain('/tvc-director 帮我做一条30秒手表广告');
    // 没有任何用户消息被改写成「请使用…技能…先用 read_file 读取 SKILL.md」祈使
    expect(sent.every((m) => !m.content.includes('read_file'))).toBe(true);
    expect(sent.every((m) => !m.content.includes('请使用「'))).toBe(true);

    // input 不含 files 键（技能现在经 store 播种，不再全量注入 state.files）
    expect(
      (captured as unknown as Record<string, unknown>)['files'],
    ).toBeUndefined();
  });

  it('续跑时把之前轮次激活的技能 SKILL.md 注入系统提示，并要求不要再 read_file 读取它', async () => {
    const def: SkillDef = {
      name: 'tvc-director',
      description: '',
      kind: 'builtin' as const,
      source: 'builtin',
      enabled: true,
      files: { 'SKILL.md': '# TVC Director\n详见 `./references/treatment.md`' },
    };
    // 第 1 轮 /command 激活技能，第 3 轮是普通追问（当前请求） → 应注入
    const history = [
      {
        role: 'user',
        content: { text: '/tvc-director 帮我做一条30秒手表广告' },
      },
      { role: 'assistant', content: { text: '（上一轮分镜）' } },
      { role: 'user', content: { text: '再短一点，改成15秒' } },
    ];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([def]),
      getFor: jest.fn(async (_userId: string, name: string) =>
        name === 'tvc-director' ? def : undefined,
      ),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedExtra = '';
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { systemPromptExtra?: string }) => {
        capturedExtra = opts.systemPromptExtra ?? '';
        return fakeAgent;
      },
    );

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'c3', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // SKILL.md 全文进了系统提示
    expect(capturedExtra).toContain('已加载技能：tvc-director');
    expect(capturedExtra).toContain('# TVC Director');
    // 明确告知不要再读 SKILL.md
    expect(capturedExtra).toContain(
      '不要再 read_file 读取 `/skills/tvc-director/SKILL.md`',
    );
    // 正文里的相对引用被改写为绝对路径，注入后仍能命中虚拟 FS
    expect(capturedExtra).toContain(
      '/skills/tvc-director/references/treatment.md',
    );
  });

  it('本轮当前请求才首次发起 /command 时不注入 SKILL.md（首次加载交给 read_file）', async () => {
    const def: SkillDef = {
      name: 'tvc-director',
      description: '',
      kind: 'builtin' as const,
      source: 'builtin',
      enabled: true,
      files: { 'SKILL.md': '# TVC Director' },
    };
    // 只有一轮，且当前请求就是 /command → 首次加载，不注入
    const history = [
      {
        role: 'user',
        content: { text: '/tvc-director 帮我做一条30秒手表广告' },
      },
    ];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([def]),
      getFor: jest.fn(async (_userId: string, name: string) =>
        name === 'tvc-director' ? def : undefined,
      ),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedExtra = 'SENTINEL';
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { systemPromptExtra?: string }) => {
        capturedExtra = opts.systemPromptExtra ?? '';
        return fakeAgent;
      },
    );

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'c4', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(capturedExtra).not.toContain('已加载技能');
  });

  it('已有任务计划时，把既定计划注入系统提示并要求按计划逐步执行、不重新拆解', async () => {
    const history = [
      { role: 'user', content: { text: '帮我规划上线流程' } },
      { role: 'assistant', content: { text: '（上一轮回复）' } },
      { role: 'user', content: { text: '继续' } },
    ];
    const plan = {
      todos: [
        { content: '写迁移脚本', status: 'completed' },
        { content: '灰度发布', status: 'in_progress' },
        { content: '全量发布', status: 'pending' },
      ],
    };

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue({ content: plan }),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([] as SkillDef[]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    // 既有计划现在经 runtime context（context.activePlan）传入，不再塞进 systemPromptExtra；
    // 由 planContinuationMiddleware 在系统提示末尾注入（盖过 todoListMiddleware 的「随时重订」）。
    let capturedContext: { activePlan?: string } | undefined;
    const fakeAgent = {
      stream: jest.fn(
        async (_input: unknown, cfg: { context?: { activePlan?: string } }) => {
          capturedContext = cfg?.context;
          return (async function* () {})();
        },
      ),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'c2', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    const planText = capturedContext?.activePlan ?? '';
    // 三个步骤连同状态都进了计划文本
    expect(planText).toContain('写迁移脚本');
    expect(planText).toContain('[in_progress] 灰度发布');
    expect(planText).toContain('全量发布');
    // 明确要求不要重新拆解
    expect(planText).toContain('请勿重新拆解');
  });

  it('run 前播种：seedSkillsStore 以 (store, userId, defs) 调用', async () => {
    const def: SkillDef = {
      name: 'tvc-director',
      description: '',
      kind: 'builtin' as const,
      source: 'builtin',
      enabled: true,
      files: { 'SKILL.md': '# tvc' },
    };
    const history = [{ role: 'user', content: { text: '测试播种' } }];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([def]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    (seedSkillsStore as jest.Mock).mockClear();

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'seed1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // 播种必须以 (store, userId, defs) 调用
    expect(seedSkillsStore).toHaveBeenCalledWith(store, 'u1', [def]);
  });

  it('stream config 的 configurable.userId === conv.userId', async () => {
    const history = [{ role: 'user', content: { text: '测试' } }];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv({ userId: 'user-99' })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(makeConv({ userId: 'user-99' })),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedConfig: { configurable?: { userId?: string } } | undefined;
    const fakeAgent = {
      stream: jest.fn(
        async (
          _input: unknown,
          cfg: { configurable?: { userId?: string } },
        ) => {
          capturedConfig = cfg;
          return (async function* () {})();
        },
      ),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'uid1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(capturedConfig?.configurable?.userId).toBe('user-99');
  });

  it('resume 续跑同样播种技能并携带 configurable.userId（worker 重启后 store 为空，不播种会技能静默失效）', async () => {
    const def: SkillDef = {
      name: 'tvc-director',
      description: '',
      kind: 'builtin' as const,
      source: 'builtin',
      enabled: true,
      files: { 'SKILL.md': '# tvc' },
    };

    const prisma = {
      conversation: {
        update: jest
          .fn()
          .mockResolvedValue(makeConv({ userId: 'user-resume' })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue(makeConv({ userId: 'user-resume' })),
      },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([def]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedConfig: { configurable?: { userId?: string } } | undefined;
    const fakeAgent = {
      stream: jest.fn(
        async (
          _input: unknown,
          cfg: { configurable?: { userId?: string } },
        ) => {
          capturedConfig = cfg;
          return (async function* () {})();
        },
      ),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);
    (seedSkillsStore as jest.Mock).mockClear();

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: {
        conversationId: 'res1',
        kind: 'resume',
        decisions: [{ type: 'approve' }],
      },
    } as Job<{ conversationId: string; kind: 'resume'; decisions: unknown[] }>);

    // ①播种与④userId 接线必须发生在 run/resume 共用作用域（设计「关键时序与接线」）
    expect(seedSkillsStore).toHaveBeenCalledWith(store, 'user-resume', [def]);
    expect(capturedConfig?.configurable?.userId).toBe('user-resume');
  });

  it('buildAgent 收到 hasSandbox:false 和 store（无沙箱时降级）', async () => {
    const history = [{ role: 'user', content: { text: '测试' } }];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedOpts: { hasSandbox?: boolean; store?: unknown } | undefined;
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { hasSandbox?: boolean; store?: unknown }) => {
        capturedOpts = opts;
        return fakeAgent;
      },
    );

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'ha1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // getUserSandbox mock 返回 null，所以 hasSandbox 应为 false
    expect(capturedOpts?.hasSandbox).toBe(false);
    // store 实例传入，以便 ReadOnlyStoreBackend namespace factory 可用
    expect(capturedOpts?.store).toBe(store);
  });

  it('buildAgent 收到 extraTools（包含 generate_image + generate_video 两个工具）', async () => {
    const history = [{ role: 'user', content: { text: '测试媒体工具注入' } }];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedOpts: { extraTools?: unknown[] } | undefined;
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { extraTools?: unknown[] }) => {
        capturedOpts = opts;
        return fakeAgent;
      },
    );

    // createMediaTools mock 已在顶层 jest.mock 返回 2 个工具占位对象
    (createMediaTools as jest.Mock).mockClear();

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'mt1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // worker 闭包注入的媒体工具必须传给 buildAgent
    expect(capturedOpts?.extraTools).toHaveLength(2);
    expect(createMediaTools).toHaveBeenCalledTimes(1);
  });

  it('有媒体资产时 buildAgent 收到的 systemPromptExtra 含「媒体资产」与 versionId', async () => {
    const history = [{ role: 'user', content: { text: '继续' } }];
    const fakeGenerations = [
      {
        id: 'gen-abc',
        type: 'image',
        versions: [
          {
            id: 'ver-cuid1234567890',
            status: 'done',
            prompt: '银色跑车影棚特写',
          },
        ],
      },
    ];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;
    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;
    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedExtra = '';
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { systemPromptExtra?: string }) => {
        capturedExtra = opts.systemPromptExtra ?? '';
        return fakeAgent;
      },
    );

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(fakeGenerations),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'media1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(capturedExtra).toContain('媒体资产');
    expect(capturedExtra).toContain('ver-cuid1234567890');
  });

  it('无媒体资产时 buildAgent 收到的 systemPromptExtra 不含「媒体资产」', async () => {
    const history = [{ role: 'user', content: { text: '继续' } }];

    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue(history),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(history.length),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;

    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;
    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;
    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    let capturedExtra = '';
    const fakeAgent = {
      stream: jest.fn(async () => (async function* () {})()),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockImplementation(
      (opts: { systemPromptExtra?: string }) => {
        capturedExtra = opts.systemPromptExtra ?? '';
        return fakeAgent;
      },
    );

    // 空资产列表
    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService([]),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'media2', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(capturedExtra).not.toContain('媒体资产');
  });
});

describe('AgentProcessor 流式聚合落库', () => {
  const aiChunk = (content: string) => new AIMessageChunk({ content });
  const aiToolMsg = (
    toolCalls: { name: string; args: Record<string, unknown> }[],
  ) =>
    new AIMessageChunk({
      content: '',
      tool_calls: toolCalls.map(
        (c, i): ToolCall => ({
          name: c.name,
          args: c.args,
          id: `call-${i}`,
          type: 'tool_call',
        }),
      ),
    });
  const toolMsg = (name: string, content: string) =>
    new ToolMessage({ name, content, tool_call_id: 'tc', status: 'success' });

  it('把逐字 token 累积成完整 message 落库；token 本身只推流不落库；工具调用前的叙述文本也保留', async () => {
    // 一轮里：先吐叙述文本(分两个 token chunk) → 调工具 → 工具结果 → 再吐最终答案
    const chunks: unknown[] = [
      [['agent'], 'messages', [aiChunk('你好')]],
      [['agent'], 'messages', [aiChunk('，世界')]],
      [
        [],
        'updates',
        {
          model_request: {
            messages: [aiToolMsg([{ name: 'search', args: { q: 'x' } }])],
          },
        },
      ],
      [['tools'], 'messages', [toolMsg('search', '{"r":1}')]],
      [['agent'], 'messages', [aiChunk('最终答案')]],
      [[], 'updates', { model_request: { messages: [aiChunk('最终答案')] } }],
    ];

    const created: { type: string; content: unknown; role: string }[] = [];
    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(
          (arg: { data: { type: string; content: unknown; role: string } }) => {
            created.push({
              type: arg.data.type,
              content: arg.data.content,
              role: arg.data.role,
            });
            return Promise.resolve({});
          },
        ),
      },
    } as unknown as PrismaService;

    const published: { type: string }[] = [];
    const streamSvc = {
      publish: jest.fn((_c: string, raw: { type: string }) => {
        published.push({ type: raw.type });
        return Promise.resolve(undefined);
      }),
    } as unknown as StreamService;

    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([] as SkillDef[]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    const store = new InMemoryStore();

    const fakeAgent = {
      stream: jest.fn(async () =>
        (async function* () {
          for (const c of chunks) yield c;
        })(),
      ),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      new AbortRegistry(),
    );
    await proc.process({
      data: { conversationId: 'agg1', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // token 只推流，不落库
    expect(published.some((p) => p.type === 'token')).toBe(true);
    expect(created.some((c) => c.type === 'token')).toBe(false);

    const messages = created.filter((c) => c.type === 'message');
    const texts = messages.map((m) => (m.content as { text?: string }).text);
    // 工具前的叙述文本被收口成一条完整 assistant message（此前会被整段丢弃）
    expect(texts).toContain('你好，世界');
    // 最终答案也作为完整 message 落库
    expect(texts).toContain('最终答案');
    // 叙述 message 落在 tool_start 之前（顺序正确）
    const order = created.map((c) => c.type);
    expect(order.indexOf('message')).toBeLessThan(order.indexOf('tool_start'));
    // 工具调用与结果照常落库，运行结束落 result
    expect(order).toContain('tool_start');
    expect(order).toContain('tool_end');
    expect(order).toContain('result');
  });
});

describe('AgentProcessor 主动停止', () => {
  const makeDeps = () => {
    const prisma = {
      conversation: {
        update: jest.fn().mockResolvedValue(makeConv()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(makeConv()),
      },
      message: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ role: 'user', content: { text: 'hi' } }]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const streamSvc = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamService;
    const skills = {
      effectiveSkillsFor: jest.fn().mockResolvedValue([]),
      getFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as SkillsService;
    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;
    return { prisma, streamSvc, skills, queue, store: new InMemoryStore() };
  };

  it('流中被 abort：发 result{stopped}、不写 failed 状态', async () => {
    const { prisma, streamSvc, skills, queue, store } = makeDeps();
    const reg = new AbortRegistry();
    const fakeAgent = {
      stream: jest.fn(async () =>
        (async function* () {
          // 模拟运行中收到停止：先 abort（processor 持有同一 controller 的 signal），再如 LangGraph 般抛错
          reg.abort('c-stop');
          throw new Error('Aborted');
          yield undefined as never; // 让函数成为 generator（不可达）
        })(),
      ),
      getState: jest.fn(async () => ({ tasks: [] })),
    };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      reg,
    );
    await proc.process({
      data: { conversationId: 'c-stop', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    // 发并持久化了 stopped result
    expect(streamSvc.publish).toHaveBeenCalledWith('c-stop', {
      type: 'result',
      payload: { status: 'stopped' },
    });
    // 不写 failed（catch 的失败分支未走到）
    const updateCalls = (prisma.conversation.update as jest.Mock).mock.calls;
    expect(
      updateCalls.find((c) => c[0]?.data?.status === 'failed'),
    ).toBeUndefined();
    // 也没有 error 事件
    const published = (streamSvc.publish as jest.Mock).mock.calls.map(
      (c) => c[1]?.type,
    );
    expect(published).not.toContain('error');
  });

  it('排队期间被停止（CAS 门 count=0 且 signal.aborted）：补发 result{stopped} 后直接退出', async () => {
    const { prisma, streamSvc, skills, queue, store } = makeDeps();
    (prisma.conversation.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
    const reg = new AbortRegistry();
    // stop 端点在 register 之后、CAS 门之前 abort 的交错：用预先注册再 abort 模拟不了
    // （processor 内部才 register），改为在 buildAgent 调用前 abort——等价于门前已 aborted。
    const fakeAgent = { stream: jest.fn(), getState: jest.fn() };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);
    // 利用 register 的实现：processor register 后我们立刻 abort 同 key
    const origRegister = reg.register.bind(reg);
    jest.spyOn(reg, 'register').mockImplementation((key: string) => {
      const handle = origRegister(key);
      reg.abort(key); // 注册即被停（模拟端点 abort 在门前到达）
      return handle;
    });

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      reg,
    );
    await proc.process({
      data: { conversationId: 'c-gate', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(streamSvc.publish).toHaveBeenCalledWith('c-gate', {
      type: 'result',
      payload: { status: 'stopped' },
    });
    expect(fakeAgent.stream).not.toHaveBeenCalled(); // 没起跑
  });

  it('排队期间被停止但 abort 发生在注册前（端点已补发）：worker 静默退出不重复发', async () => {
    const { prisma, streamSvc, skills, queue, store } = makeDeps();
    (prisma.conversation.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
    const reg = new AbortRegistry(); // 未被 abort：signal.aborted=false
    const fakeAgent = { stream: jest.fn(), getState: jest.fn() };
    (buildAgent as jest.Mock).mockReturnValue(fakeAgent);

    const proc = new AgentProcessor(
      prisma,
      streamSvc,
      skills,
      {},
      queue,
      store,
      makeMediaService(),
      reg,
    );
    await proc.process({
      data: { conversationId: 'c-quiet', kind: 'run' },
    } as Job<{ conversationId: string; kind: 'run' }>);

    expect(streamSvc.publish).not.toHaveBeenCalled();
    expect(fakeAgent.stream).not.toHaveBeenCalled();
  });
});
