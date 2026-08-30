/**
 * 画布运行状态的呈现映射。侧栏列表与索引页共用一份，两处的状态语言才不会走形。
 *
 * 颜色一律走语义 token：告警用 --warning（`bg-warning`），不写死 amber/red 之类的调色板色，
 * 否则暗色主题下对比度失控（CLAUDE.md §7）。
 */
export const CANVAS_STATUS_DOT: Record<string, string> = {
  running: "bg-primary animate-pulse",
  queued: "bg-primary/60",
  waiting_approval: "bg-warning",
  done: "bg-muted-foreground/40",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/40",
  idle: "bg-muted-foreground/30",
};

/** 状态点的兜底样式：后端加了新状态而前端还没跟上时，至少不是透明的。 */
export const CANVAS_STATUS_DOT_FALLBACK = "bg-muted-foreground/30";

/** 给状态点配的人话（索引页在点旁边显示，光靠颜色区分不了七种状态）。 */
export const CANVAS_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  waiting_approval: "Needs approval",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
};

/**
 * 相对时间，用于「上次动过是多久以前」。
 * 只在客户端渲染（画布相关组件都是 "use client" 且数据来自 react-query），
 * 不存在服务端与客户端算出不同文案的水合问题。
 */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
