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
