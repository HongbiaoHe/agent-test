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
  });

  afterEach(() => jest.clearAllMocks());

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

  it('列表只含未删除的会话，置顶在前、再按创建时间倒序，并带回 pinnedAt', async () => {
    prisma.conversation.findMany.mockResolvedValue([]);
    await service.list('tenant-1');
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', deletedAt: null },
        orderBy: [{ pinnedAt: 'desc' }, { createdAt: 'desc' }],
        select: expect.objectContaining({ pinnedAt: true }),
      }),
    );
  });

  it('置顶写入当前时刻，取消置顶清空；都先校验会话归属', async () => {
    await service.setPinned('conv-1', 'tenant-1', true);
    await service.setPinned('conv-1', 'tenant-1', false);
    const [pin, unpin] = prisma.conversation.update.mock.calls.map(
      (c) => (c[0] as { data: { pinnedAt: Date | null } }).data.pinnedAt,
    );
    expect(pin).toBeInstanceOf(Date);
    expect(unpin).toBeNull();
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv-1', tenantId: 'tenant-1', deletedAt: null },
      }),
    );
  });

  it('别人的 / 已删除的会话：置顶与删除都 404，不写库', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.setPinned('x', 'tenant-1', true),
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
