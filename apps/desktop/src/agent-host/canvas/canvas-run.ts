/**
 * 一轮运行里本机 agent 对画布的写入：规矩与 Web 画布 agent 运行时一致——
 *  - 第一次写某块画布（op / 生成 / 拼接）前向 Web 后端申请运行锁，之后每 CANVAS_LOCK_RENEW_MS 续期（心跳）；
 *  - 本轮结束（含失败、中止）释放；停在审批上时不放（与 Web 画布 agent 等审批时画布仍算忙一致），
 *    续跑沿用同一个持锁方，审批被停止 / 对话被删时才释放；desktop 崩溃则心跳停了、锁到期自动失效；
 *  - 持锁期间 Web / 其它端的用户只能拖位置，Web 画布 agent 不能开跑；反过来拿不到锁时把原因回给模型。
 *
 * 执行端（CanvasToolBackend）的工具逻辑在 agent-core（与服务端画布 agent 共用），这里只负责「经 Web 接口落地 + 锁」。
 */
import { randomUUID } from 'node:crypto';
import { CANVAS_LOCK_RENEW_MS, resolveNodeIdIn } from '@agent-test/canvas-schema';
import {
  CanvasUnavailableError,
  type CanvasToolBackend,
} from '@agent-test/agent-core/canvas/canvas-tools';
import { WebApiError } from '../web-media/web-api';
import type { CanvasWeb } from './canvas-web';

/** Web 后端的 CANVAS_BUSY 业务码（apps/backend common/errors/error-code.ts） */
const CANVAS_BUSY_CODE = 70003;

const BUSY_MESSAGE =
  '这块画布正被占用（Web 上的画布 agent 正在运行，或另一个桌面端的 agent 正在改它），现在不能修改。告诉用户稍后再试，不要反复重试。';

interface HeldLock {
  timer: ReturnType<typeof setInterval>;
}

export class CanvasRunSession {
  /** 本轮的持锁方标识：续期 / 释放 / 每次写入都带它 */
  readonly holderId = randomUUID();
  private readonly held = new Map<string, HeldLock>();
  /** 正在申请中的锁（同一步里并发的多个写入只申请一次） */
  private readonly acquiring = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly web: CanvasWeb,
    /** 给其它端显示的说明（对话标题） */
    private readonly label: () => string | null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** 这块画布的执行端；scope = 本机对话 id（附件按它记账，见 /media-api） */
  backendFor(canvasId: string, scope: string): CanvasToolBackend {
    /**
     * 节点 id 列表缓存（给短 id 解析用）：共享工具每解析一个 id 都要查一次，不缓存就是每次拉整份快照
     * （批量改 20 个节点 = 20 次）。列表只在增删节点 / 清空时变，本执行端自己的写入就地维护；
     * 解析不到时（别人刚加的节点）重拉一次再解析。
     */
    let ids: string[] | null = null;
    const loadIds = async (): Promise<string[]> => {
      ids = (await this.web.snapshot(canvasId)).nodes.map((n) => n.id);
      return ids;
    };
    return {
      snapshot: async () => {
        const s = await this.web.snapshot(canvasId);
        ids = s.nodes.map((n) => n.id);
        return { nodes: s.nodes, edges: s.edges, mockMedia: s.mockMedia };
      },
      resolveNodeId: async (id) =>
        resolveNodeIdIn(ids ?? (await loadIds()), id) ?? resolveNodeIdIn(await loadIds(), id),
      applyOp: async (op) => {
        await this.ensureLock(canvasId);
        const r = await this.web.agentOp(canvasId, this.holderId, op);
        if (r.patch.op === 'add_node') ids = ids && [...ids, r.patch.node.id];
        else if (r.patch.op === 'remove_node' || r.patch.op === 'clear') ids = null;
        return r;
      },
      findUploadedAsset: (versionId) => this.web.uploadedAsset(canvasId, scope, versionId),
      prepareNodeConfig: (type, req) => this.web.nodeConfig(canvasId, type, req),
      createGeneration: async (input) => {
        await this.ensureLock(canvasId);
        return this.web.agentGeneration(canvasId, this.holderId, input);
      },
      createConcat: async (sources) => {
        await this.ensureLock(canvasId);
        return this.web.agentConcat(canvasId, this.holderId, sources);
      },
      modelCatalog: (type) => this.web.modelCatalog(type),
    };
  }

  /** 本轮已持有这块画布的锁 */
  holds(canvasId: string): boolean {
    return this.held.has(canvasId);
  }

  /** 释放本轮持有的全部锁（本轮结束时调用；失败只记日志——锁到期也会自动失效） */
  async close(): Promise<void> {
    this.closed = true;
    const ids = [...this.held.keys()];
    for (const id of ids) this.drop(id);
    await Promise.all(
      ids.map((id) =>
        this.web.unlock(id, this.holderId).catch((e: unknown) => this.log(`释放画布锁失败 ${id}: ${String(e)}`)),
      ),
    );
  }

  private ensureLock(canvasId: string): Promise<void> {
    if (this.closed) return Promise.reject(new CanvasUnavailableError('本轮运行已结束'));
    if (this.held.has(canvasId)) return Promise.resolve();
    let pending = this.acquiring.get(canvasId);
    if (!pending) {
      pending = this.acquire(canvasId).finally(() => this.acquiring.delete(canvasId));
      this.acquiring.set(canvasId, pending);
    }
    return pending;
  }

  private async acquire(canvasId: string): Promise<void> {
    try {
      await this.web.lock(canvasId, this.holderId, this.label());
    } catch (e) {
      if (isBusy(e)) throw new CanvasUnavailableError(BUSY_MESSAGE);
      throw e;
    }
    // 申请途中本轮已结束（用户停止 / 运行失败）：close() 时这把锁还没到手、没放掉——现在立刻放掉，
    // 不开心跳，否则它会被一直续期、把画布锁到 desktop 重启
    if (this.closed) {
      await this.web
        .unlock(canvasId, this.holderId)
        .catch((e: unknown) => this.log(`释放画布锁失败 ${canvasId}: ${String(e)}`));
      throw new CanvasUnavailableError('本轮运行已结束');
    }
    const timer = setInterval(() => void this.renew(canvasId), CANVAS_LOCK_RENEW_MS);
    // 心跳不该拖住进程退出
    timer.unref?.();
    this.held.set(canvasId, { timer });
  }

  private async renew(canvasId: string): Promise<void> {
    if (!this.held.has(canvasId)) return;
    try {
      await this.web.lock(canvasId, this.holderId, this.label());
    } catch (e) {
      // 锁丢了（过期后被别人拿走）：停掉心跳，下次写入会重新申请（拿不到就把原因回给模型）
      if (isBusy(e)) this.drop(canvasId);
      this.log(`画布锁续期失败 ${canvasId}: ${String(e)}`);
    }
  }

  private drop(canvasId: string): void {
    const h = this.held.get(canvasId);
    if (h) clearInterval(h.timer);
    this.held.delete(canvasId);
  }
}

function isBusy(e: unknown): boolean {
  return e instanceof WebApiError && e.code === CANVAS_BUSY_CODE;
}
