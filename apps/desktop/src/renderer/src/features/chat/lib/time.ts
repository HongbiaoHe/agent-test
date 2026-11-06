/** 对话区的时间 / 耗时格式化：日期按界面语言（currentLocale），时刻固定 24 小时制。 */
import { currentLocale, i18n } from "@/lib/i18n";

import type { Locale } from "../../../../../shared/i18n";

/** 界面语言可能在运行中切换：格式化器按语言懒建并缓存 */
function makeFormatters(locale: Locale) {
  return {
    clock: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    clockSeconds: new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    monthDay: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    monthDayYear: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }),
    monthDayClock: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
    monthDayYearClock: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
    full: new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  };
}

const cache = new Map<Locale, ReturnType<typeof makeFormatters>>();

function fmt(): ReturnType<typeof makeFormatters> {
  const locale = currentLocale();
  let f = cache.get(locale);
  if (!f) {
    f = makeFormatters(locale);
    cache.set(locale, f);
  }
  return f;
}

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

function sameYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() === new Date(b).getFullYear();
}

function dateLabel(at: number, now: number): string {
  return sameYear(at, now) ? fmt().monthDay.format(at) : fmt().monthDayYear.format(at);
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

/** 消息旁的短时刻：今天只写 14:32，其它日子带日期（Oct 22, 14:32 / 10月22日 14:32）。 */
export function formatMessageTime(at: number, now: number): string {
  if (isSameDay(at, now)) return fmt().clock.format(at);
  return sameYear(at, now) ? fmt().monthDayClock.format(at) : fmt().monthDayYearClock.format(at);
}

/** 完整日期时间（Tooltip 用）：Fri, Oct 24, 2026, 14:32:05。 */
export function formatFullDateTime(at: number): string {
  return fmt().full.format(at);
}

/** 只要时分秒（同一天内的结束时刻）。 */
export function formatClockSeconds(at: number): string {
  return fmt().clockSeconds.format(at);
}

/** 日期分隔线文案：今天 / 昨天 / 10月22日（跨年带年份）。 */
export function formatDayLabel(at: number, now: number): string {
  const diff = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (diff === 0) return i18n.t("chat.time.today");
  if (diff === 1) return i18n.t("chat.time.yesterday");
  return dateLabel(at, now);
}
