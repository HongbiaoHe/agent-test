"use client";

import { Separator } from "@/components/ui/separator";

import { useNow } from "../_hooks/use-now";
import { formatDayLabel, isSameDay } from "../_lib/time";

/**
 * 跨天日期分隔线（Today / Yesterday / Oct 22）。
 * hideIfToday：会话第一条消息前的分隔线——全是今天的会话不显示，从往日开始的会话才显示。
 */
export function DayDivider({ at, hideIfToday }: { at: number; hideIfToday: boolean }) {
  // 每分钟校正一次：页面开过零点后 Today / Yesterday 跟着变
  const now = useNow(true, 60_000);
  if (hideIfToday && isSameDay(at, now)) return null;
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <Separator className="flex-1" />
      <span className="shrink-0">{formatDayLabel(at, now)}</span>
      <Separator className="flex-1" />
    </div>
  );
}
