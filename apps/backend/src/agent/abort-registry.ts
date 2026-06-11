/**
 * 进程内 Abort 注册表（主动停止运行用，设计见
 * docs/superpowers/specs/2026-06-11-stop-run-design.md）。
 *
 * 两个实例（见 AbortModule）：agent-run 按 conversationId、media-gen 按 versionId。
 * API 与两个 BullMQ worker 同进程，进程内 Map 即可触达运行中的任务；
 * 多实例部署时需换 Redis 广播（设计文档留档，当前 YAGNI 不做）。
 *
 * 竞态规则（result 事件恰好一份）：`abort()` 返回 true ⇒ 同一 controller 的
 * signal.aborted 必为 true，由 worker 侧负责停止收尾事件；返回 false ⇒ worker
 * 尚未注册（排队中）或已结束，由 stop 端点按 CAS 命中数决定补发。
 */
export class AbortRegistry {
  private readonly map = new Map<string, AbortController>();

  /**
   * 注册一个可中止句柄。dispose 仅当 map 中仍是本次注册的 controller 时才删除——
   * 同 key 被并发 job 覆盖注册后（如 timeout job 与 resume run 共存场景），
   * 旧句柄的 dispose 不得误删新注册。
   */
  register(key: string): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    this.map.set(key, controller);
    return {
      signal: controller.signal,
      dispose: () => {
        if (this.map.get(key) === controller) this.map.delete(key);
      },
    };
  }

  /** 中止并移除该 key 的注册；未注册（没在跑）返回 false。 */
  abort(key: string): boolean {
    const controller = this.map.get(key);
    if (!controller) return false;
    this.map.delete(key);
    controller.abort();
    return true;
  }
}

/** DI token：agent-run 注册表（按 conversationId） */
export const AGENT_ABORTS = Symbol('AGENT_ABORTS');
/** DI token：media-gen 注册表（按 versionId） */
export const MEDIA_ABORTS = Symbol('MEDIA_ABORTS');
