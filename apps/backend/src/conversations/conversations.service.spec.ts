/**
 * conversations.service 单元测试
 *
 * 只测纯逻辑 + 路径校验分支：
 * - downloadFile 对含 '..' 的 relPath 抛出 INVALID_PATH（400）
 * - downloadFile 对以 '/' 开头的 relPath 抛出 INVALID_PATH（400）
 *
 * 其余涉及 Daytona 沙箱 / Prisma 的路径属于云端集成，无单元测试价值。
 */

import { HttpStatus } from '@nestjs/common';
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
