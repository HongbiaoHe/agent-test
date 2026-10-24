"use client";

import { useEffect, useState } from "react";

/**
 * 当前时间，active 时每 intervalMs 刷新一次（进行中的耗时计时用）。
 * 计时值由「起点 → Date.now()」现算，不累加 tick：后台标签页里 interval 被节流，
 * 切回前台（visibilitychange）立刻补一次，读数马上对齐。
 * setState 都在定时器 / 事件回调里，不在 effect 体内同步调用（Next16 规则）。
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    // 挂载后由不活跃转为活跃时，初值可能是很久以前的：下一帧先校正一次
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, intervalMs]);

  return now;
}
