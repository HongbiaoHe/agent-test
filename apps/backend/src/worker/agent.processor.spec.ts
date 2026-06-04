import type { Job, Queue } from 'bullmq';
import { buildAgent } from '../agent/agent.factory';
import type { CommandDef } from '../commands/command-registry.service';
import { CommandRegistryService } from '../commands/command-registry.service';
import { StreamService } from '../events/stream.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentProcessor } from './agent.processor';

// 避免加载 deepagents / google-genai 等重依赖，并能捕获传给 agent 的 input
jest.mock('../agent/agent.factory', () => ({ buildAgent: jest.fn() }));

describe('AgentProcessor 多轮重放', () => {
  it('重放历史时原样传递用户的 /command 消息，不注入 read_file/请使用技能 祈使（否则每轮重复触发同一技能、重复 read_file 同一文件）', async () => {
    const def: CommandDef = {
      name: 'tvc-director',
      description: '',
      domain: 'tvc',
      raw: '# tvc',
      files: { 'SKILL.md': '# tvc' },
    };

    // 第 1 轮是 /command，第 2 轮是普通追问 —— 模拟多轮续跑时的全量历史
    const history = [
      { role: 'user', content: { text: '/tvc-director 帮我做一条30秒手表广告' } },
      { role: 'assistant', content: { text: '（上一轮的分镜结果）' } },
      { role: 'user', content: { text: '再短一点，改成15秒' } },
    ];

    const prisma = {
      conversation: { update: jest.fn().mockResolvedValue({}) },
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

    const commands = {
      all: jest.fn(() => [def]),
      get: jest.fn((n: string) => (n === 'tvc-director' ? def : undefined)),
    } as unknown as CommandRegistryService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;

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

    const proc = new AgentProcessor(prisma, streamSvc, commands, {}, queue);
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
  });

  it('续跑时把之前轮次激活的技能 SKILL.md 注入系统提示，并要求不要再 read_file 读取它', async () => {
    const def: CommandDef = {
      name: 'tvc-director',
      description: '',
      domain: 'tvc',
      raw: '# tvc',
      files: { 'SKILL.md': '# TVC Director\n详见 `./references/treatment.md`' },
    };
    // 第 1 轮 /command 激活技能，第 3 轮是普通追问（当前请求） → 应注入
    const history = [
      { role: 'user', content: { text: '/tvc-director 帮我做一条30秒手表广告' } },
      { role: 'assistant', content: { text: '（上一轮分镜）' } },
      { role: 'user', content: { text: '再短一点，改成15秒' } },
    ];

    const prisma = {
      conversation: { update: jest.fn().mockResolvedValue({}) },
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

    const commands = {
      all: jest.fn(() => [def]),
      get: jest.fn((n: string) => (n === 'tvc-director' ? def : undefined)),
    } as unknown as CommandRegistryService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;

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

    const proc = new AgentProcessor(prisma, streamSvc, commands, {}, queue);
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
    expect(capturedExtra).toContain('/skills/tvc-director/references/treatment.md');
  });

  it('本轮当前请求才首次发起 /command 时不注入 SKILL.md（首次加载交给 read_file）', async () => {
    const def: CommandDef = {
      name: 'tvc-director',
      description: '',
      domain: 'tvc',
      raw: '# tvc',
      files: { 'SKILL.md': '# TVC Director' },
    };
    // 只有一轮，且当前请求就是 /command → 首次加载，不注入
    const history = [
      { role: 'user', content: { text: '/tvc-director 帮我做一条30秒手表广告' } },
    ];

    const prisma = {
      conversation: { update: jest.fn().mockResolvedValue({}) },
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

    const commands = {
      all: jest.fn(() => [def]),
      get: jest.fn((n: string) => (n === 'tvc-director' ? def : undefined)),
    } as unknown as CommandRegistryService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;

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

    const proc = new AgentProcessor(prisma, streamSvc, commands, {}, queue);
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
      conversation: { update: jest.fn().mockResolvedValue({}) },
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

    const commands = {
      all: jest.fn(() => [] as CommandDef[]),
      get: jest.fn(() => undefined),
    } as unknown as CommandRegistryService;

    const queue = { add: jest.fn().mockResolvedValue({}) } as unknown as Queue;

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

    const proc = new AgentProcessor(prisma, streamSvc, commands, {}, queue);
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
});
