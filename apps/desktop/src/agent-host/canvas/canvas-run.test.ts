import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasOpInput, CanvasSnapshot } from '@agent-test/canvas-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationRepo } from '../db/conversations';
import { openDatabase } from '../db/database';
import { WebApiError } from '../web-media/web-api';
import { CanvasRunSession } from './canvas-run';
import { type CanvasRunContext, createBoundCanvasTools, createOpenCanvasTool } from './canvas-tools';
import type { CanvasWeb } from './canvas-web';

const snapshot = (id: string, nodeIds: string[] = []): CanvasSnapshot => ({
  id,
  title: `画布 ${id}`,
  status: 'idle',
  model: null,
  thinkingLevel: null,
  approvalMode: 'review',
  mockMedia: false,
  mockMediaAvailable: false,
  revision: 1,
  totalTokens: 0,
  focusNodeIds: [],
  runLock: null,
  nodes: nodeIds.map((nid) => ({
    id: nid,
    type: 'image_gen',
    x: 0,
    y: 0,
    version: 1,
    label: null,
    prompt: null,
    assetPath: null,
    mediaGenerationId: null,
    mediaChannel: null,
    mediaModel: null,
    mediaParams: null,
    mediaVersionId: null,
    mediaStatus: null,
    mediaMock: false,
    outputs: [],
  })),
  edges: [],
});

/** 假的 Web 画布接口：记录调用；lock 的行为由用例决定 */
function fakeWeb(lock: () => Promise<unknown> = () => Promise.resolve({})) {
  const calls: string[] = [];
  const ops: CanvasOpInput[] = [];
  const web = {
    lock: vi.fn((id: string, holderId: string) => {
      calls.push(`lock ${id} ${holderId.length > 0}`);
      return lock();
    }),
    unlock: vi.fn((id: string) => {
      calls.push(`unlock ${id}`);
      return Promise.resolve();
    }),
    snapshot: vi.fn((id: string) => Promise.resolve(snapshot(id, ['node00aaaa11']))),
    agentOp: vi.fn((_id: string, _holder: string, op: CanvasOpInput) => {
      ops.push(op);
      return Promise.resolve({ revision: ops.length, patch: { op: 'clear', revision: ops.length } });
    }),
  };
  // cast-at-injection：这些用例只用到上面几个方法
  return { web: web as unknown as CanvasWeb, calls, ops, mock: web };
}

describe('CanvasRunSession（本轮的画布运行锁）', () => {
  it('第一次写入时申请锁、同一块画布只申请一次；本轮结束释放', async () => {
    const { web, calls, ops } = fakeWeb();
    const session = new CanvasRunSession(web, () => '对话标题');
    const backend = session.backendFor('c1', 'conv-1');
    await Promise.all([backend.applyOp({ op: 'clear' }), backend.applyOp({ op: 'clear' })]);
    expect(calls.filter((c) => c.startsWith('lock'))).toHaveLength(1);
    expect(ops).toHaveLength(2);
    expect(session.holds('c1')).toBe(true);
    await session.close();
    expect(calls).toContain('unlock c1');
    expect(session.holds('c1')).toBe(false);
  });

  it('申请锁途中本轮结束（用户停止）：锁到手后立刻释放、不开心跳，写入报「本轮运行已结束」', async () => {
    let grant: () => void = () => {};
    const { web, calls, ops } = fakeWeb(() => new Promise<unknown>((resolve) => (grant = () => resolve({}))));
    const session = new CanvasRunSession(web, () => null);
    const pending = session.backendFor('c1', 'conv-1').applyOp({ op: 'clear' });
    await Promise.resolve();
    await session.close(); // 此时锁还没到手，close 没有可放的
    grant();
    await expect(pending).rejects.toThrow('本轮运行已结束');
    expect(calls).toContain('unlock c1');
    expect(session.holds('c1')).toBe(false);
    expect(ops).toEqual([]);
  });

  it('短 id 解析走缓存的节点 id 列表：连续解析只拉一次快照；本执行端新建的节点直接可解析；解析不到时重拉一次', async () => {
    const { web, mock } = fakeWeb();
    mock.agentOp.mockImplementation((_id: string, _holder: string, op: CanvasOpInput) =>
      Promise.resolve(
        op.op === 'add_node'
          ? { revision: 2, patch: { op: 'add_node', node: snapshot('c1', ['nodeNEW99xx']).nodes[0], revision: 2 } }
          : { revision: 2, patch: { op: 'clear', revision: 2 } },
      ),
    );
    const backend = new CanvasRunSession(web, () => null).backendFor('c1', 'conv-1');
    expect(await backend.resolveNodeId?.('aa11')).toBe('node00aaaa11');
    expect(await backend.resolveNodeId?.('node00aaaa11')).toBe('node00aaaa11');
    expect(mock.snapshot).toHaveBeenCalledTimes(1);
    await backend.applyOp({ op: 'add_node', type: 'image_gen' });
    expect(await backend.resolveNodeId?.('99xx')).toBe('nodeNEW99xx');
    expect(mock.snapshot).toHaveBeenCalledTimes(1);
    // 不认识的 id：重拉一次快照再解析（别人刚加的节点），还是没有就 null
    expect(await backend.resolveNodeId?.('zzzz')).toBeNull();
    expect(mock.snapshot).toHaveBeenCalledTimes(2);
  });

  it('画布被占用（CANVAS_BUSY）：抛「画布暂不可用」，工具把原因回给模型而不是废掉整轮', async () => {
    const { web, ops } = fakeWeb(() => Promise.reject(new WebApiError(400, 70003, 'busy')));
    const session = new CanvasRunSession(web, () => null);
    const ctx: CanvasRunContext = {
      web,
      session,
      conversationId: 'conv-1',
      current: () => 'c1',
      bind: () => {},
    };
    const clear = createBoundCanvasTools(ctx).find((t) => t.name === 'clear_canvas');
    const out: unknown = await clear?.invoke({});
    expect(String(out)).toContain('正被占用');
    expect(ops).toEqual([]);
  });

  it('没绑定画布：工具提示先 create_canvas / open_canvas；list_media_models 不重复挂（由媒体工具提供）', async () => {
    const { web } = fakeWeb();
    const ctx: CanvasRunContext = {
      web,
      session: new CanvasRunSession(web, () => null),
      conversationId: 'conv-1',
      current: () => null,
      bind: () => {},
    };
    const tools = createBoundCanvasTools(ctx);
    expect(tools.some((t) => t.name === 'list_media_models')).toBe(false);
    const out: unknown = await tools.find((t) => t.name === 'delete_node')?.invoke({ nodeId: 'x' });
    expect(String(out)).toContain('create_canvas');
  });
});

describe('画布绑定', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spark-canvas-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('open_canvas 把对话的当前画布切过去；latestForCanvas 取最近一个绑定着它的对话', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const repo = new ConversationRepo(db, () => dir);
    const a = repo.create(null);
    const b = repo.create(null);
    const { web } = fakeWeb();
    const ctxOf = (conversationId: string): CanvasRunContext => ({
      web,
      session: new CanvasRunSession(web, () => null),
      conversationId,
      current: () => repo.require(conversationId).canvasId,
      bind: (id) => repo.setCanvas(conversationId, id),
    });
    const out: unknown = await createOpenCanvasTool(ctxOf(a.id)).invoke({ canvasId: 'c9' });
    expect(JSON.parse(String(out))).toMatchObject({ canvasId: 'c9', title: '画布 c9', opened: true });
    expect(repo.require(a.id).canvasId).toBe('c9');
    expect(repo.latestForCanvas('c9')?.id).toBe(a.id);

    // 按绑定时刻而不是最后活跃时刻：b 后绑定，即使 a 之后又有新消息（updated_at 更新），也是 b
    await new Promise((r) => setTimeout(r, 5));
    repo.setCanvas(b.id, 'c9');
    await new Promise((r) => setTimeout(r, 5));
    repo.update(a.id, { title: 'a 之后又聊了' });
    expect(repo.latestForCanvas('c9')?.id).toBe(b.id);
    // 解绑后不再算
    repo.setCanvas(b.id, null);
    expect(repo.latestForCanvas('c9')?.id).toBe(a.id);
    expect(repo.latestForCanvas('nope')).toBeNull();
    db.close();
  });
});
