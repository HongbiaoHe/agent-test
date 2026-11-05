/** 对话区的时间 / 耗时格式化（界面是英文，固定 en-US + 24 小时制，不随浏览器语言漂移）。 */

const LOCALE = "en-US";

const CLOCK = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const CLOCK_SECONDS = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const MONTH_DAY = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const FULL = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

function dateLabel(at: number, now: number): string {
  return new Date(at).getFullYear() === new Date(now).getFullYear()
    ? MONTH_DAY.format(at)
    : MONTH_DAY_YEAR.format(at);
}

/**
 * 耗时：<10s 带一位小数（2.3s），<1m 取整秒（12s），再往上 1m 23s / 1h 2m。
 * live = 还在走的计时：每秒才刷新一次，一律取整秒，避免小数位跳得比刷新频率还快。
 */
export function formatDuration(ms: number, live = false): string {
  const safe = Math.max(0, ms);
  if (!live && safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
  const secs = Math.floor(safe / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** 消息旁的短时刻：今天只写 14:32，其它日子带日期（Oct 22, 14:32）。 */
export function formatMessageTime(at: number, now: number): string {
  return isSameDay(at, now) ? CLOCK.format(at) : `${dateLabel(at, now)}, ${CLOCK.format(at)}`;
}

/** 完整日期时间（Tooltip 用）：Fri, Oct 24, 2026, 14:32:05。 */
export function formatFullDateTime(at: number): string {
  return FULL.format(at);
}

/** 只要时分秒（同一天内的结束时刻）。 */
export function formatClockSeconds(at: number): string {
  return CLOCK_SECONDS.format(at);
}

/** 日期分隔线文案：Today / Yesterday / Oct 22（跨年带年份）。 */
export function formatDayLabel(at: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return dateLabel(at, now);
}
