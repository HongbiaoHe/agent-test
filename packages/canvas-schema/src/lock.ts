/**
 * 画布运行锁：desktop 本机 agent 改画布期间，与服务端画布 agent 运行时同样的规矩——
 * 其它端的用户只能拖位置、服务端画布 agent 不能开跑；反过来服务端 agent 在跑时 desktop 拿不到锁。
 *
 * 锁有时限，持锁方定时续期（心跳）；本轮结束主动释放，desktop 崩溃则到期自动失效。
 */
export interface CanvasRunLock {
  /** 持锁方标识（desktop 每轮运行生成一个），续期 / 释放必须带同一个 */
  holderId: string;
  /** 给其它端显示的说明，如 desktop 对话标题；可空 */
  label: string | null;
  /** 到期时刻（ISO）；过了这个时刻锁自动失效 */
  expiresAt: string;
}

/**
 * 第三方 agent 经画布 MCP 对外服务改画布时也持同一把锁（每次写入隐式续期），holderId 带这个前缀
 * （后接授权 id），label 是客户端 / 令牌名——其它端据此显示「外部 agent 在改」而不是「desktop 在改」。
 */
export const MCP_LOCK_HOLDER_PREFIX = 'mcp:';

/** 这把锁是否由画布 MCP 对外服务（第三方 agent）持有 */
export function isMcpLock(lock: Pick<CanvasRunLock, 'holderId'>): boolean {
  return lock.holderId.startsWith(MCP_LOCK_HOLDER_PREFIX);
}

/** 锁的时长：持锁方每 CANVAS_LOCK_RENEW_MS 续一次，连续丢两次心跳仍在有效期内 */
export const CANVAS_LOCK_TTL_MS = 60_000;
export const CANVAS_LOCK_RENEW_MS = 20_000;

/** 锁此刻是否有效 */
export function isLockActive(
  lock: Pick<CanvasRunLock, 'expiresAt'> | null | undefined,
  now: number = Date.now(),
): boolean {
  return !!lock && Date.parse(lock.expiresAt) > now;
}

/** 服务端画布 agent 运行中的会话状态（此时用户结构编辑被拒） */
export const CANVAS_BUSY_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_approval',
];

/** 画布此刻是否有 agent 在改（服务端 agent 在跑，或 desktop agent 持有有效的锁）：用户只能拖位置 */
export function isCanvasBusy(
  snap: { status: string; runLock: CanvasRunLock | null },
  now: number = Date.now(),
): boolean {
  return CANVAS_BUSY_STATUSES.includes(snap.status) || isLockActive(snap.runLock, now);
}

/**
 * canvas_lock 事件的 payload（{ runLock }）→ 锁；形状不对返回 undefined（调用方忽略这条事件）。
 * 客户端收到后直接写进本地快照，不要等重拉：锁先于 agent 的第一个增量到达，画布据此立刻进入
 * 「agent 在操作」状态（只读 + 自动聚焦到新节点）。
 */
export function runLockFromEvent(
  payload: unknown,
): CanvasRunLock | null | undefined {
  if (typeof payload !== 'object' || payload === null || !('runLock' in payload)) {
    return undefined;
  }
  const lock = payload.runLock;
  if (lock === null) return null;
  if (
    typeof lock === 'object' &&
    'holderId' in lock &&
    typeof lock.holderId === 'string' &&
    'expiresAt' in lock &&
    typeof lock.expiresAt === 'string' &&
    'label' in lock &&
    (typeof lock.label === 'string' || lock.label === null)
  ) {
    return { holderId: lock.holderId, label: lock.label, expiresAt: lock.expiresAt };
  }
  return undefined;
}
