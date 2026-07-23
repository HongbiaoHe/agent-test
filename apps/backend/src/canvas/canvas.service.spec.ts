/**
 * CanvasService 单元测试（mock Prisma / 队列 / StreamService / media / aborts）。
 *
 * 覆盖冲突模型核心（最易出 bug）：
 * - 运行期 user 结构变更被拒（CANVAS_BUSY）
 * - 空闲期 user 带过期 baseRevision → CANVAS_CONFLICT
 * - agent add_node：建节点 + 追加 op + revision CAS 自增 + 广播 canvas_patch
 * - moveNode：LWW，不占 revision，广播 move_node
 */
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { AbortRegistry } from '../agent/abort-registry';
import { CANVAS_ABORTS } from './canvas.abort';
import { CanvasService } from './canvas.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { ErrorCodes } from '../common/errors/error-code';
import type { AddNodeOp, UpdateNodeOp } from './canvas.types';

interface MockTx {
  canvasSession: { findUnique: jest.Mock; updateMany: jest.Mock };
  canvasNode: {
    create: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  canvasEdge: { upsert: jest.Mock; deleteMany: jest.Mock };
  canvasOp: { create: jest.Mock };
}

function makeTx(): MockTx {
  return {
    canvasSession: { findUnique: jest.fn(), updateMany: jest.fn() },
    canvasNode: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    canvasEdge: { upsert: jest.fn(), deleteMany: jest.fn() },
    canvasOp: { create: jest.fn() },
  };
}

describe('CanvasService', () => {
  let service: CanvasService;
  let tx: MockTx;
  const mockPrisma = {
    $transaction: jest.fn(),
    canvasNode: { updateMany: jest.fn() },
    canvasSession: { findFirst: jest.fn() },
  };
  const mockStream = { publish: jest.fn() };
  const mockQueue = { add: jest.fn() };
  const mockMedia = { cancelByConversation: jest.fn() };

  beforeEach(async () => {
    tx = makeTx();
    // $transaction(cb) → cb(tx)
    mockPrisma.$transaction.mockImplementation((cb: (t: MockTx) => unknown) =>
      cb(tx),
    );
    const module = await Test.createTestingModule({
      providers: [
        CanvasService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('canvas-run'), useValue: mockQueue },
        { provide: MediaService, useValue: mockMedia },
        { provide: CANVAS_ABORTS, useValue: new AbortRegistry() },
      ],
    }).compile();
    service = module.get(CanvasService);
  });

  afterEach(() => jest.clearAllMocks());

  it('运行期 user 结构变更被拒（CANVAS_BUSY）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    const op: UpdateNodeOp = { op: 'update_node', nodeId: 'n1', text: 'x' };
    await expect(service.applyOp('s1', 'user', op, 3)).rejects.toMatchObject({
      errCode: ErrorCodes.CANVAS_BUSY.code,
    });
    expect(tx.canvasNode.update).not.toHaveBeenCalled();
    expect(mockStream.publish).not.toHaveBeenCalled();
  });

  it('空闲期 user 带过期 baseRevision → CANVAS_CONFLICT', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'idle',
      revision: 5,
    });
    const op: UpdateNodeOp = { op: 'update_node', nodeId: 'n1', text: 'x' };
    await expect(service.applyOp('s1', 'user', op, 4)).rejects.toMatchObject({
      errCode: ErrorCodes.CANVAS_CONFLICT.code,
    });
    expect(tx.canvasNode.update).not.toHaveBeenCalled();
  });

  it('agent add_node：建节点 + 追加 op + revision 自增 + 广播 canvas_patch', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 5,
    });
    tx.canvasNode.create.mockResolvedValue({
      id: 'n-new',
      type: 'text',
      x: 10,
      y: 20,
      version: 0,
      label: null,
      text: 'hi',
      prompt: null,
      assetPath: null,
      mediaGenerationId: null,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });

    const op: AddNodeOp = {
      op: 'add_node',
      type: 'text',
      x: 10,
      y: 20,
      text: 'hi',
    };
    const r = await service.applyOp('s1', 'agent', op);

    expect(r.revision).toBe(6);
    expect(r.patch).toMatchObject({ op: 'add_node', revision: 6 });
    expect(tx.canvasOp.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ seq: 6, actor: 'agent' }),
      }),
    );
    // revision CAS：where 带旧 revision
    expect(tx.canvasSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1', revision: 5 },
        data: { revision: 6 },
      }),
    );
    expect(mockStream.publish).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'canvas_patch' }),
    );
  });

  it('moveNode：LWW updateMany + 广播 move_node（不占 revision）', async () => {
    mockPrisma.canvasSession.findFirst.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      status: 'idle',
      revision: 5,
    });
    mockPrisma.canvasNode.updateMany.mockResolvedValue({ count: 1 });

    await service.moveNode('s1', 'n1', 100, 200, 't1');

    expect(mockPrisma.canvasNode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'n1', sessionId: 's1' },
        data: { x: 100, y: 200 },
      }),
    );
    expect(mockStream.publish).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        type: 'canvas_patch',
        payload: expect.objectContaining({ op: 'move_node', x: 100, y: 200 }),
      }),
    );
  });
});
