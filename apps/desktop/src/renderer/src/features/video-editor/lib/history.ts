/**
 * 撤销 / 重做栈（内存快照，纯函数，单测见 history.test.ts）。
 * 快照是整份工程：工程很小（几百个对象），整份存比算差量简单可靠。
 */

export const HISTORY_LIMIT = 100;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * 记一步新状态：旧 present 进 past（超过 limit 丢最早的），清空 future。
 * coalesce = 与上一步合并（连续拖滑块 / 连续打字只算一步）：只替换 present，不进 past。
 */
export function pushHistory<T>(h: History<T>, next: T, opts: { coalesce?: boolean; limit?: number } = {}): History<T> {
  if (next === h.present) return h;
  if (opts.coalesce) return { past: h.past, present: next, future: [] };
  const limit = opts.limit ?? HISTORY_LIMIT;
  const past = [...h.past, h.present];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] };
}

export function undoHistory<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redoHistory<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}
