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
import { CHECKPOINTER } from '../agent/checkpointer.provider';
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
    findMany: jest.Mock;
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
      findMany: jest.fn(),
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
    canvasNode: { updateMany: jest.fn(), findMany: jest.fn() },
    canvasSession: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    canvasRun: { aggregate: jest.fn(), deleteMany: jest.fn() },
    canvasTokenUsage: { deleteMany: jest.fn() },
    canvasMessage: {
      deleteMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    mediaVersion: { findMany: jest.fn() },
  };
  // checkpointer：清空会话时需删掉该 thread 的 agent 上下文（RedisSaver.deleteThread）
  const mockCheckpointer = { deleteThread: jest.fn() };
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
        { provide: CHECKPOINTER, useValue: mockCheckpointer },
      ],
    }).compile();
    service = module.get(CanvasService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('agentCanvasContext 的关注范围裁剪', () => {
    /** buildSnapshot 走 canvasSession.findUnique（include nodes/edges）+ canvasRun.aggregate */
    function seedCanvas(focusNodeIds: unknown) {
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        id: 's1',
        title: 't',
        status: 'idle',
        model: null,
        thinkingLevel: null,
        revision: 1,
        focusNodeIds,
        nodes: [
          {
            id: 'aaaaaa1',
            type: 'text',
            x: 0,
            y: 0,
            version: 1,
            label: 'A',
            text: null,
            prompt: null,
            assetPath: null,
            mediaGenerationId: null,
          },
          {
            id: 'bbbbbb2',
            type: 'image_gen',
            x: 400,
            y: 0,
            version: 1,
            label: 'B',
            text: null,
            prompt: null,
            assetPath: null,
            mediaGenerationId: null,
          },
          {
            id: 'cccccc3',
            type: 'video_gen',
            x: 800,
            y: 0,
            version: 1,
            label: 'C',
            text: null,
            prompt: null,
            assetPath: null,
            mediaGenerationId: null,
          },
        ],
        edges: [
          { id: 'e1', source: 'aaaaaa1', target: 'bbbbbb2' },
          { id: 'e2', source: 'bbbbbb2', target: 'cccccc3' },
        ],
      });
      mockPrisma.mediaVersion.findMany.mockResolvedValue([]);
      mockPrisma.canvasRun.aggregate.mockResolvedValue({
        _sum: { totalTokens: 0 },
      });
    }

    it('未圈定时列出全部节点与连线', async () => {
      seedCanvas(null);
      const text = await service.agentCanvasContext('s1');
      expect(text).toContain('节点（3）');
      expect(text).toContain('连线（2）');
      expect(text).not.toContain('### 关注范围');
    });

    it('圈定后只列圈中的节点，连线取至少一端在圈内的', async () => {
      seedCanvas(['bbbbbb2']);
      const text = await service.agentCanvasContext('s1');
      expect(text).toContain('节点（1）');
      // 只剩 B 自己；两条边都碰到 B，故都保留（模型才知道 B 的上游从哪来）
      expect(text).toContain('连线（2）');
      expect(text).not.toMatch(/- aaaaaa1 \[text\]/);
      expect(text).toContain('用户已圈定 1 个节点加入本次对话');
      expect(text).toContain('画布上另有 2 个节点未圈定');
    });

    it('安全区仍按全部节点计算（否则新节点会压在圈外的节点上）', async () => {
      seedCanvas(['aaaaaa1']);
      const text = await service.agentCanvasContext('s1');
      // 最右的 C 在 x=800，加卡宽 280 与间距 40 → 右侧安全线 1120
      expect(text).toContain('右侧 x ≥ 1120');
    });
  });

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

  it('add_node：text 节点的 outputs 由正文派生（正文为空则为空数组）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 1,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    const base = {
      id: 'n-new',
      type: 'text',
      x: 0,
      y: 0,
      version: 0,
      label: null,
      prompt: null,
      assetPath: null,
      mediaGenerationId: null,
    };

    tx.canvasNode.create.mockResolvedValue({ ...base, text: 'hi' });
    const withText = await service.applyOp('s1', 'agent', {
      op: 'add_node',
      type: 'text',
      text: 'hi',
    });
    expect(withText.patch).toMatchObject({
      op: 'add_node',
      node: { outputs: [{ type: 'text', content: 'hi' }] },
    });

    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 2,
    });
    tx.canvasNode.create.mockResolvedValue({ ...base, text: '   ' });
    const blank = await service.applyOp('s1', 'agent', {
      op: 'add_node',
      type: 'text',
    });
    expect(blank.patch).toMatchObject({ node: { outputs: [] } });
  });

  it('add_edge：text → image_gen 合法，落库并广播', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    tx.canvasNode.findMany.mockResolvedValue([
      { id: 'a', type: 'text' },
      { id: 'b', type: 'image_gen' },
    ]);
    tx.canvasEdge.upsert.mockResolvedValue({
      id: 'e1',
      source: 'a',
      target: 'b',
    });

    const r = await service.applyOp('s1', 'agent', {
      op: 'add_edge',
      source: 'a',
      target: 'b',
    });
    expect(r.patch).toMatchObject({ op: 'add_edge', edge: { id: 'e1' } });
    expect(tx.canvasEdge.upsert).toHaveBeenCalled();
  });

  it('add_edge：video_gen → image_gen 非法（image_gen 只收 text/image）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    tx.canvasNode.findMany.mockResolvedValue([
      { id: 'a', type: 'video_gen' },
      { id: 'b', type: 'image_gen' },
    ]);

    await expect(
      service.applyOp('s1', 'agent', {
        op: 'add_edge',
        source: 'a',
        target: 'b',
      }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.CANVAS_EDGE_INVALID.code });
    expect(tx.canvasEdge.upsert).not.toHaveBeenCalled();
  });

  it('add_edge：video_gen → video_gen 合法（video 入边只串联画布，不参与生成）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    tx.canvasNode.findMany.mockResolvedValue([
      { id: 'a', type: 'video_gen' },
      { id: 'b', type: 'video_gen' },
    ]);
    tx.canvasEdge.upsert.mockResolvedValue({
      id: 'e3',
      source: 'a',
      target: 'b',
    });

    const r = await service.applyOp('s1', 'agent', {
      op: 'add_edge',
      source: 'a',
      target: 'b',
    });
    expect(r.patch).toMatchObject({ op: 'add_edge', edge: { id: 'e3' } });
  });

  it('add_edge：image_gen → video_gen 合法（图作首帧）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    tx.canvasNode.findMany.mockResolvedValue([
      { id: 'a', type: 'image_gen' },
      { id: 'b', type: 'video_gen' },
    ]);
    tx.canvasEdge.upsert.mockResolvedValue({
      id: 'e2',
      source: 'a',
      target: 'b',
    });

    const r = await service.applyOp('s1', 'agent', {
      op: 'add_edge',
      source: 'a',
      target: 'b',
    });
    expect(r.patch).toMatchObject({ op: 'add_edge', edge: { id: 'e2' } });
  });

  it('add_edge：指向无输入端口的 text 节点 → CANVAS_EDGE_INVALID，不落库', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 3,
    });
    // revision CAS 在 op 分派之前跑，故仍要 mock；校验抛错后整个事务回滚
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    tx.canvasNode.findMany.mockResolvedValue([
      { id: 'a', type: 'image_gen' },
      { id: 'b', type: 'text' },
    ]);

    await expect(
      service.applyOp('s1', 'agent', {
        op: 'add_edge',
        source: 'a',
        target: 'b',
      }),
    ).rejects.toMatchObject({ errCode: ErrorCodes.CANVAS_EDGE_INVALID.code });
    expect(tx.canvasEdge.upsert).not.toHaveBeenCalled();
  });

  it('update_node 回填 mediaGenerationId：patch 带上生成状态（排队中也看得见）', async () => {
    tx.canvasSession.findUnique.mockResolvedValue({
      id: 's1',
      status: 'running',
      revision: 5,
    });
    tx.canvasNode.findFirst.mockResolvedValue({ id: 'n1' });
    tx.canvasNode.update.mockResolvedValue({
      id: 'n1',
      type: 'video_gen',
      x: 0,
      y: 0,
      version: 1,
      label: null,
      text: null,
      prompt: null,
      assetPath: null,
      mediaGenerationId: 'g1',
    });
    tx.canvasSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      { id: 'v1', generationId: 'g1', status: 'queued' },
    ]);

    const op: UpdateNodeOp = {
      op: 'update_node',
      nodeId: 'n1',
      mediaGenerationId: 'g1',
    };
    const r = await service.applyOp('s1', 'agent', op);

    // 不带状态的话前端只能等 worker 真正开跑才知道这个节点在生成队列里
    expect(r.patch).toMatchObject({
      op: 'update_node',
      node: { id: 'n1', mediaVersionId: 'v1', mediaStatus: 'queued' },
    });
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

  describe('list 分页', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        title: `画布${i}`,
        status: 'idle',
        updatedAt: new Date(),
      }));

    it('满页 → 裁剪到 limit 并给 nextCursor=末项 id（多取一探测）', async () => {
      mockPrisma.canvasSession.findMany.mockResolvedValue(rows(3));
      const r = await service.list('t1', { limit: 2 });
      expect(r.items).toHaveLength(2);
      expect(r.nextCursor).toBe('c1');
      expect(mockPrisma.canvasSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 3,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('不足一页 → nextCursor=null', async () => {
      mockPrisma.canvasSession.findMany.mockResolvedValue(rows(1));
      const r = await service.list('t1', { limit: 2 });
      expect(r.items).toHaveLength(1);
      expect(r.nextCursor).toBeNull();
    });

    it('带 cursor → prisma 调用含 cursor + skip 1', async () => {
      mockPrisma.canvasSession.findMany.mockResolvedValue(rows(1));
      await service.list('t1', { cursor: 'c9', limit: 2 });
      expect(mockPrisma.canvasSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 'c9' }, skip: 1 }),
      );
    });
  });

  describe('clearMessages（清空会话记录 + agent 上下文）', () => {
    beforeEach(() => {
      mockPrisma.canvasSession.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: 'idle',
        revision: 3,
      });
    });

    it('空闲期：删消息 + 删 checkpointer thread + status 归 idle + 广播', async () => {
      const r = await service.clearMessages('s1', 't1');

      expect(mockPrisma.canvasMessage.deleteMany).toHaveBeenCalledWith({
        where: { sessionId: 's1' },
      });
      expect(mockCheckpointer.deleteThread).toHaveBeenCalledWith('s1');
      expect(mockPrisma.canvasSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's1' },
          data: { status: 'idle' },
        }),
      );
      expect(mockStream.publish).toHaveBeenCalledWith('s1', {
        type: 'messages_cleared',
        payload: {},
      });
      expect(r).toEqual({ cleared: true });
    });

    it('token 审计（CanvasRun / CanvasTokenUsage）保留不删', async () => {
      await service.clearMessages('s1', 't1');
      expect(mockPrisma.canvasRun.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.canvasTokenUsage.deleteMany).not.toHaveBeenCalled();
    });

    it('运行期拒绝（CANVAS_BUSY），不删任何数据', async () => {
      mockPrisma.canvasSession.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: 'running',
        revision: 3,
      });
      await expect(service.clearMessages('s1', 't1')).rejects.toMatchObject({
        errCode: ErrorCodes.CANVAS_BUSY.code,
      });
      expect(mockPrisma.canvasMessage.deleteMany).not.toHaveBeenCalled();
      expect(mockCheckpointer.deleteThread).not.toHaveBeenCalled();
    });

    it('checkpointer 删除失败不影响清空（DB 已清即成功）', async () => {
      mockCheckpointer.deleteThread.mockRejectedValueOnce(
        new Error('redis down'),
      );
      await expect(service.clearMessages('s1', 't1')).resolves.toEqual({
        cleared: true,
      });
      expect(mockPrisma.canvasMessage.deleteMany).toHaveBeenCalled();
    });
  });

  describe('clearPlan（手动作废任务计划）', () => {
    beforeEach(() => {
      mockPrisma.canvasSession.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: 'idle',
        revision: 3,
      });
      mockPrisma.canvasMessage.count.mockResolvedValue(7);
    });

    it('追加一条空 plan_update 作废标记（不删历史）+ 广播', async () => {
      const r = await service.clearPlan('s1', 't1');

      expect(mockPrisma.canvasMessage.create).toHaveBeenCalledWith({
        data: {
          sessionId: 's1',
          role: 'assistant',
          type: 'plan_update',
          content: { todos: [] },
          seq: 7,
        },
      });
      expect(mockPrisma.canvasMessage.deleteMany).not.toHaveBeenCalled();
      expect(mockStream.publish).toHaveBeenCalledWith('s1', {
        type: 'plan_update',
        payload: { todos: [] },
      });
      expect(r).toEqual({ cleared: true });
    });

    it('运行期也允许作废（计划归用户掌控，不看 status）', async () => {
      mockPrisma.canvasSession.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: 'running',
        revision: 3,
      });
      await expect(service.clearPlan('s1', 't1')).resolves.toEqual({
        cleared: true,
      });
    });

    it('非本租户 → CANVAS_NOT_FOUND，不写任何标记', async () => {
      mockPrisma.canvasSession.findFirst.mockResolvedValue(null);
      await expect(service.clearPlan('s1', 't-other')).rejects.toMatchObject({
        errCode: ErrorCodes.CANVAS_NOT_FOUND.code,
      });
      expect(mockPrisma.canvasMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('snapshot totalTokens', () => {
    it('聚合该会话全部 run 的 totalTokens 回传（无 run 时为 0）', async () => {
      // assertOwner 归属校验
      mockPrisma.canvasSession.findFirst.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        status: 'idle',
        revision: 0,
      });
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        id: 's1',
        title: 't',
        status: 'idle',
        model: null,
        revision: 0,
        nodes: [],
        edges: [],
      });
      mockPrisma.canvasRun.aggregate.mockResolvedValue({
        _sum: { totalTokens: 1234 },
      });

      const snap = await service.snapshot('s1', 't1');

      expect(snap.totalTokens).toBe(1234);
      expect(mockPrisma.canvasRun.aggregate).toHaveBeenCalledWith({
        where: { sessionId: 's1' },
        _sum: { totalTokens: true },
      });
    });
  });

  /**
   * 短 id：注入给模型的画布状态用完整 cuid 的后 6 位（完整 id 会让这段膨胀近 3 倍，而它每次
   * 画布变化都要追加进上下文）。工具侧靠 resolveNodeId 反解，短 id / 完整 id 都要吃。
   */
  describe('短 id 与反解', () => {
    // 同一秒创建的 cuid，前 8 位相同、后 6 位不同 —— 正是不能用前缀、只能用后缀的原因
    const idA = 'cms7n6wca00jjsp0somugi7qu';
    const idB = 'cms7n6wco00jrsp0s6esi073c';

    it('注入文本里的节点与连线 id 都是后 6 位短 id', async () => {
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        id: 's1',
        title: 't',
        status: 'idle',
        model: null,
        revision: 0,
        nodes: [
          {
            id: idA,
            type: 'text',
            x: 40,
            y: 40,
            label: '创意',
            text: null,
            prompt: null,
            assetPath: null,
            mediaGenerationId: null,
          },
          {
            id: idB,
            type: 'image_gen',
            x: 360,
            y: 40,
            label: null,
            text: null,
            prompt: '出图',
            assetPath: null,
            mediaGenerationId: null,
          },
        ],
        edges: [{ id: 'e1', source: idA, target: idB }],
      });
      mockPrisma.canvasRun.aggregate.mockResolvedValue({
        _sum: { totalTokens: 0 },
      });

      const text = await service.agentCanvasContext('s1');

      expect(text).toContain('- ugi7qu [text] "创意" @(40,40)');
      expect(text).toContain('- si073c [image_gen] "出图" @(360,40)');
      expect(text).toContain('- ugi7qu → si073c'); // 连线两端也用短 id
      expect(text).not.toContain(idA);
      expect(text).not.toContain(idB);
    });

    it('反解：短 id 按后缀匹配，完整 id 精确匹配', async () => {
      mockPrisma.canvasNode.findMany.mockResolvedValue([
        { id: idA },
        { id: idB },
      ]);
      await expect(service.resolveNodeId('s1', 'ugi7qu')).resolves.toBe(idA);
      await expect(service.resolveNodeId('s1', idB)).resolves.toBe(idB);
    });

    it('反解不到 / 后缀有歧义 → null（由工具回明确错误给模型）', async () => {
      mockPrisma.canvasNode.findMany.mockResolvedValue([
        { id: 'aaaaaa' },
        { id: 'bbaaaa' },
      ]);
      await expect(service.resolveNodeId('s1', 'zzzzzz')).resolves.toBeNull();
      // 'aaaa' 同时是两个 id 的后缀 → 歧义，不能猜
      await expect(service.resolveNodeId('s1', 'aaaa')).resolves.toBeNull();
    });
  });
});
