"use client";

import { useNow } from "../_hooks/use-now";
import { formatDuration } from "../_lib/time";

/**
 * 步骤耗时：有 endedAt 显示定值；否则是进行中的计时（服务端起点 → 本地 now，每秒刷新），
 * 起点来自服务端事件时间，刷新页面后从历史重建，不归零。
 */
export function Elapsed({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const live = endedAt == null;
  const now = useNow(live);
  return (
    // normal-case：工具 chip 的标签是 uppercase，耗时单位保持小写（4m 12s 而非 4M 12S）
    <span className="normal-case tabular-nums">{formatDuration((endedAt ?? now) - startedAt, live)}</span>
  );
}
