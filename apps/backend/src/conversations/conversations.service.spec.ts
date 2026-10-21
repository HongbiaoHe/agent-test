/**
 * conversations.service 单元测试
 *
 * 只测纯逻辑 + 路径校验分支：
 * - downloadFile 对含 '..' 的 relPath 抛出 INVALID_PATH（400）
 * - downloadFile 对以 '/' 开头的 relPath 抛出 INVALID_PATH（400）
 *
 * 其余涉及 Daytona 沙箱 / Prisma 的路径属于云端集成，无单元测试价值。
 */

// 偏好服务会引入沙箱提供方 SDK（深 ESM 链，jest 加载失败）；偏好已整体 mock，不需要真实提供方
jest.mock('../agent/sandbox-providers', () => ({}));
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AbortRegistry, AGENT_ABORTS } from '../agent/abort-registry';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { ConversationsService } from './conversations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { SandboxSettingsService } from '../sandbox/sandbox-settings.service';

// 最小 Mock：只需 conversation.findFirst 返回一条记录，不触及队列/沙箱
const mockPrisma = {
  conversation: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  message: {
    create: jest.fn(),
    count: jest.fn(),
  },
};

const mockSkills = { getFor: jest.fn() };
const mockQueue = { add: jest.fn() };

// 拦截 findUserSandbox：在路径校验测试中不应该被调用到
jest.mock('../agent/sandbox', () => ({
  findUserSandbox: jest.fn(),
  getUserSandbox: jest.fn(),
}));

describe('ConversationsService – downloadFile 路径校验', () => {
  let service: ConversationsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SkillsService, useValue: mockSkills },
        { provide: getQueueToken('agent-run'), useValue: mockQueue },
        { provide: StreamService, useValue: { publish: jest.fn() } },
        {
          provide: MediaService,
          useValue: { cancelByConversation: jest.fn() },
        },
        { provide: AGENT_ABORTS, useValue: new AbortRegistry() },
        {
          provide: SandboxSettingsService,
          useValue: { resolve: jest.fn().mockResolvedValue('daytona') },
        },
      ],
    }).compile();

    service = module.get(ConversationsService);

    // 默认：会话归属校验通过（租户匹配）
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
  });

  afterEach(() => jest.clearAllMocks());

  it('relPath 含 ".." 片段时抛出 INVALID_PATH(400)', async () => {
    await expect(
      service.downloadFile('conv-1', 'tenant-1', '../etc/passwd'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.INVALID_PATH.code,
    });
  });

  it('relPath 以 "/" 开头时抛出 INVALID_PATH(400)', async () => {
    await expect(
      service.downloadFile('conv-1', 'tenant-1', '/etc/passwd'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.INVALID_PATH.code,
    });
  });

  it('relPath 含多段 ".." 时抛出 INVALID_PATH(400)', async () => {
    await expect(
      service.downloadFile('conv-1', 'tenant-1', 'a/../../secret'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.INVALID_PATH.code,
    });
  });
});

describe('ConversationsService – 空会话创建与续聊', () => {
  let service: ConversationsService;
  const commitAttachments = jest.fn().mockResolvedValue([]);

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SkillsService, useValue: mockSkills },
        { provide: getQueueToken('agent-run'), useValue: mockQueue },
        { provide: StreamService, useValue: { publish: jest.fn() } },
        {
          provide: MediaService,
          useValue: { cancelByConversation: jest.fn(), commitAttachments },
        },
        { provide: AGENT_ABORTS, useValue: new AbortRegistry() },
        {
          provide: SandboxSettingsService,
          useValue: { resolve: jest.fn().mockResolvedValue('daytona') },
        },
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    commitAttachments.mockResolvedValue([]);
  });

  it('只发附件不写字：附件转正并存进消息，空 goal 回退成文件名', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      status: 'idle',
      goal: '',
    });
    mockPrisma.message.count.mockResolvedValue(0);
    const attachments = [
      {
        versionId: 'v1',
        type: 'image',
        url: 'https://cdn/a.png',
        filename: 'a.png',
        contentType: 'image/png',
      },
      {
        versionId: 'v2',
        type: 'video',
        url: 'https://cdn/b.mp4',
        filename: 'b.mp4',
        contentType: 'video/mp4',
      },
    ];
    commitAttachments.mockResolvedValue(attachments);

    await service.appendMessage(
      'conv-1',
      '',
      'tenant-1',
      'u1',
      undefined,
      undefined,
      ['v1', 'v2'],
    );

    expect(commitAttachments).toHaveBeenCalledWith('conv-1', 'u1', [
      'v1',
      'v2',
    ]);
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: expect.objectContaining({ goal: 'a.png, b.mp4' }),
    });
    expect(mockPrisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: 'user',
        content: { text: '', attachments },
      }),
    });
  });

  it('正文与附件都没有 → CONVERSATION_GOAL_EMPTY；附件不合法 → 整条拒绝、会话不动', async () => {
    await expect(
      service.appendMessage('conv-1', '  ', 'tenant-1', 'u1'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_GOAL_EMPTY.code,
    });

    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      status: 'done',
      goal: 'g',
    });
    commitAttachments.mockRejectedValue(
      new BusinessException(ErrorCodes.MEDIA_ATTACHMENT_INVALID),
    );
    await expect(
      service.appendMessage(
        'conv-1',
        'hi',
        'tenant-1',
        'u1',
        undefined,
        undefined,
        ['bad'],
      ),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_ATTACHMENT_INVALID.code,
    });
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('goal 为空 → 创建 idle 空会话：不落首条消息、不入队', async () => {
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conv-new' });

    const r = await service.create(undefined, 'tenant-1', 'u1');

    expect(r).toEqual({ conversationId: 'conv-new' });
    expect(mockPrisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ goal: '', status: 'idle' }),
    });
    expect(mockPrisma.message.create).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('goal 非空 → 维持原行为：落消息并入队', async () => {
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conv-2' });
    mockSkills.getFor.mockResolvedValue(undefined);

    await service.create('do something', 'tenant-1', 'u1');

    expect(mockPrisma.message.create).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalled();
  });

  it('idle 会话可追加：状态置 queued，空 goal 回填为首条消息内容', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      status: 'idle',
      goal: '',
    });
    mockPrisma.message.count.mockResolvedValue(0);

    await service.appendMessage('conv-1', 'hello world', 'tenant-1', 'u1');

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: expect.objectContaining({ status: 'queued', goal: 'hello world' }),
    });
    expect(mockQueue.add).toHaveBeenCalled();
  });

  it('已有 goal 的会话追加时不覆盖 goal', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      status: 'done',
      goal: 'original goal',
    });
    mockPrisma.message.count.mockResolvedValue(2);

    await service.appendMessage('conv-1', 'follow up', 'tenant-1', 'u1');

    const data = (
      mockPrisma.conversation.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(data.status).toBe('queued');
    expect(data).not.toHaveProperty('goal');
  });

  it('创建空会话时落下选定的模型与思考档位', async () => {
    mockPrisma.conversation.create.mockResolvedValue({ id: 'conv-th' });

    await service.create(
      undefined,
      'tenant-1',
      'u1',
      'deepseek:deepseek-flash',
      'on',
    );

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'deepseek:deepseek-flash',
        thinkingLevel: 'on',
      }),
    });
  });

  it('追加时带了思考档位就更新到会话上（resume/超时兜底复用）；没带则不动既有档位', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      status: 'done',
      goal: 'g',
    });
    mockPrisma.message.count.mockResolvedValue(2);

    await service.appendMessage(
      'conv-1',
      'a',
      'tenant-1',
      'u1',
      undefined,
      'high',
    );
    await service.appendMessage('conv-1', 'b', 'tenant-1', 'u1');

    const [withLevel, without] = mockPrisma.conversation.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(withLevel.thinkingLevel).toBe('high');
    expect(without).not.toHaveProperty('thinkingLevel');
  });
});

describe('ConversationsService – stop（主动停止）', () => {
  let service: ConversationsService;
  let aborts: AbortRegistry;
  let mockStream: { publish: jest.Mock };
  let mockMedia: { cancelByConversation: jest.Mock };
  const updateMany = jest.fn();

  beforeEach(async () => {
    aborts = new AbortRegistry();
    mockStream = { publish: jest.fn() };
    mockMedia = { cancelByConversation: jest.fn() };
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'u1' }),
        updateMany,
      },
      message: { count: jest.fn().mockResolvedValue(3), create: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SkillsService, useValue: mockSkills },
        { provide: getQueueToken('agent-run'), useValue: mockQueue },
        { provide: StreamService, useValue: mockStream },
        { provide: MediaService, useValue: mockMedia },
        { provide: AGENT_ABORTS, useValue: aborts },
        {
          provide: SandboxSettingsService,
          useValue: { resolve: jest.fn().mockResolvedValue('daytona') },
        },
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('运行中（worker 已注册）：abort=true，端点不补发 result（由 worker 收尾），状态 CAS 到 stopped', async () => {
    const { signal } = aborts.register('conv-1');
    updateMany.mockResolvedValue({ count: 1 });

    const r = await service.stop('conv-1', 'tenant-1');

    expect(r).toEqual({ stopped: true });
    expect(signal.aborted).toBe(true);
    expect(mockMedia.cancelByConversation).toHaveBeenCalledWith('conv-1');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'stopped' } }),
    );
    // worker 负责发 result：端点不重复补发
    expect(mockStream.publish).not.toHaveBeenCalled();
  });

  it('排队/审批中（无 worker 注册）：abort=false 且 CAS 命中 → 端点补发并持久化 result{stopped}', async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const r = await service.stop('conv-1', 'tenant-1');

    expect(r).toEqual({ stopped: true });
    expect(mockStream.publish).toHaveBeenCalledWith('conv-1', {
      type: 'result',
      payload: { status: 'stopped' },
    });
  });

  it('已结束（无注册、CAS 不命中）：幂等返回 stopped:false，不发事件', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    const r = await service.stop('conv-1', 'tenant-1');

    expect(r).toEqual({ stopped: false });
    expect(mockStream.publish).not.toHaveBeenCalled();
  });
});

describe('ConversationsService – 置顶与删除', () => {
  let service: ConversationsService;
  let aborts: AbortRegistry;
  const prisma = {
    conversation: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    message: { count: jest.fn(), create: jest.fn() },
  };
  const media = { cancelByConversation: jest.fn() };

  beforeEach(async () => {
    aborts = new AbortRegistry();
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      userId: 'u1',
    });
    prisma.conversation.updateMany.mockResolvedValue({ count: 0 });
    const module = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SkillsService, useValue: mockSkills },
        { provide: getQueueToken('agent-run'), useValue: mockQueue },
        { provide: StreamService, useValue: { publish: jest.fn() } },
        { provide: MediaService, useValue: media },
        { provide: AGENT_ABORTS, useValue: aborts },
        {
          provide: SandboxSettingsService,
          useValue: { resolve: jest.fn().mockResolvedValue('daytona') },
        },
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('列表只含未删除的会话，置顶在前、再按创建时间倒序，并带回 pinnedAt / title', async () => {
    prisma.conversation.findMany.mockResolvedValue([]);
    await service.list('tenant-1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', deletedAt: null },
        orderBy: [{ pinnedAt: 'desc' }, { createdAt: 'desc' }],
        select: expect.objectContaining({ pinnedAt: true, title: true }),
      }),
    );
  });

  it('置顶写入当前时刻，取消置顶清空；都先校验会话归属', async () => {
    await service.update('conv-1', 'tenant-1', { pinned: true });
    await service.update('conv-1', 'tenant-1', { pinned: false });
    const [pin, unpin] = prisma.conversation.update.mock.calls.map(
      (c) => (c[0] as { data: { pinnedAt: Date | null } }).data,
    );
    expect(pin.pinnedAt).toBeInstanceOf(Date);
    expect(unpin.pinnedAt).toBeNull();
    // 只改传了的字段：置顶不碰标题
    expect(pin).not.toHaveProperty('title');
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1', tenantId: 'tenant-1', deletedAt: null },
      }),
    );
  });

  it('重命名：去掉首尾空白后写入；空串清除为 NULL；不碰置顶', async () => {
    await service.update('conv-1', 'tenant-1', { title: '  秋日读书会海报  ' });
    await service.update('conv-1', 'tenant-1', { title: '   ' });
    const [named, cleared] = prisma.conversation.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(named).toEqual({ title: '秋日读书会海报' });
    expect(cleared).toEqual({ title: null });
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, pinnedAt: true, title: true },
      }),
    );
  });

  it('别人的 / 已删除的会话：置顶、重命名与删除都 404，不写库', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.update('x', 'tenant-1', { pinned: true }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    await expect(
      service.update('x', 'tenant-1', { title: '新名字' }),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    await expect(service.remove('x', 'tenant-1')).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('删除运行中的会话：先停止（abort + 取消媒体 + CAS 到 stopped），再打删除标记', async () => {
    const { signal } = aborts.register('conv-1');
    prisma.conversation.updateMany.mockResolvedValue({ count: 1 });

    expect(await service.remove('conv-1', 'tenant-1')).toEqual({
      deleted: true,
    });

    expect(signal.aborted).toBe(true);
    expect(media.cancelByConversation).toHaveBeenCalledWith('conv-1');
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { deletedAt: expect.any(Date) as Date },
    });
  });

  it('已删除的会话：详情 404、不能续聊', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(service.findOne('conv-1', 'tenant-1')).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    await expect(
      service.appendMessage('conv-1', 'hi', 'tenant-1', 'u1'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    for (const [arg] of prisma.conversation.findFirst.mock.calls as [
      { where: Record<string, unknown> },
    ][]) {
      expect(arg.where).toMatchObject({ deletedAt: null });
    }
  });
});

describe('ConversationsService – token 报表', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s));
  const row = (
    id: string,
    turnMessageId: string,
    model: string,
    input: number,
    output: number,
    total: number,
    cacheRead: number,
    s: number,
  ) => ({
    id,
    conversationId: 'conv-1',
    turnMessageId,
    messageId: `ai-${id}`,
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    createdAt: at(s),
  });
  const prisma = {
    conversation: {
      findFirst: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'u1' }),
    },
    conversationTokenUsage: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          row('1', 'turn-a', 'gemini', 100, 10, 150, 0, 1),
          row('2', 'turn-a', 'gemini', 200, 20, 220, 80, 2),
          row('3', 'turn-b', 'deepseek', 50, 5, 55, 0, 9),
        ]),
    },
    message: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'turn-a', content: { text: '做个海报' } },
        {
          id: 'turn-b',
          content: {
            text: '',
            attachments: [{ versionId: 'v', type: 'image', filename: 'a.png' }],
          },
        },
      ]),
    },
  };
  let service: ConversationsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SkillsService, useValue: mockSkills },
        { provide: getQueueToken('agent-run'), useValue: mockQueue },
        { provide: StreamService, useValue: { publish: jest.fn() } },
        { provide: MediaService, useValue: {} },
        { provide: AGENT_ABORTS, useValue: new AbortRegistry() },
        { provide: SandboxSettingsService, useValue: {} },
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  it('总计 / 按模型 / 按轮（最新在前，目标取触发消息，起止取首末次调用）', async () => {
    const r = await service.tokenReport('conv-1', 'tenant-1');

    expect(r.totals).toMatchObject({
      calls: 3,
      input: 350,
      output: 35,
      total: 425,
      cacheRead: 80,
      // gemini 的 total 含思考：150-110 + 220-220 = 40
      reasoning: 40,
    });
    expect(r.byModel.map((m) => [m.model, m.total])).toEqual([
      ['gemini', 370],
      ['deepseek', 55],
    ]);
    expect(
      r.runs.map((run) => [
        run.runId,
        run.goal,
        run.totals.calls,
        run.startedAt,
        run.endedAt,
      ]),
    ).toEqual([
      ['turn-b', '[a.png]', 1, at(9).toISOString(), at(9).toISOString()],
      ['turn-a', '做个海报', 2, at(1).toISOString(), at(2).toISOString()],
    ]);
  });

  it('会话不属于当前租户 → CONVERSATION_NOT_FOUND，不查明细', async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    prisma.conversationTokenUsage.findMany.mockClear();
    await expect(
      service.tokenReport('conv-x', 'tenant-1'),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
    expect(prisma.conversationTokenUsage.findMany).not.toHaveBeenCalled();
  });
});
