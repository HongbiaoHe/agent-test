"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

import { formatDuration } from "../_lib/time";

// Claude Code 招牌的盲文点阵 spinner 帧（unicode 文本字形，非 emoji）。
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 轮换的趣味动词短语，营造「正在动脑」的交互感。
const WORDS = [
  "Pondering",
  "Brewing ideas",
  "Connecting the dots",
  "Cooking up a plan",
  "Herding thoughts",
  "Polishing words",
  "Reticulating splines",
];

function subscribeReducedMotion(callback: () => void) {
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

/** prefers-reduced-motion：SSR 与首帧返回 false（默认动画），client 挂载后校正——无 effect setState。 */
function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/**
 * Claude Code 风格的「思考中」指示器：盲文点阵 spinner + 轮换中文动词 + 已用秒数。
 * 由 ChatThread 在整轮 busy 期间保持挂载、用 visible 控显隐，秒数跨多个空档连续累计。
 * 起点 startedAt = 本轮用户消息的服务端时间：刷新页面后从历史重建，计时不归零；
 * 读数按「起点 → Date.now()」现算，后台标签页节流后切回来也是准的。
 * 没有起点（旧数据）时退回挂载时刻。
 * reduced-motion 下不跑点阵/呼吸动画，只保留信息性的秒数走字。
 */
export function ThinkingIndicator({
  visible,
  startedAt,
}: {
  visible: boolean;
  startedAt: number | null;
}) {
  const reduced = usePrefersReducedMotion();
  // 惰性初始化（useState 初始化器里调用 Date.now 是允许的，渲染体内则不行）
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // 80ms 一帧驱动点阵；reduced-motion 降到 1s（只为秒数走字）。setState 在回调里（非 effect 体内同步），不踩 set-state-in-effect。
    const t = setInterval(() => setNow(Date.now()), reduced ? 1000 : 80);
    return () => clearInterval(t);
  }, [reduced]);

  if (!visible) return null;

  const ms = Math.max(0, now - (startedAt ?? mountedAt));
  const frame = reduced ? FRAMES[0] : FRAMES[Math.floor(ms / 80) % FRAMES.length];
  const word = WORDS[Math.floor(ms / 2600) % WORDS.length];
  const elapsed = formatDuration(ms, true);

  return (
    <div className="flex items-center gap-2 text-sm">
      {/* 给屏幕阅读器一条稳定播报，避免逐帧/逐秒刷屏 */}
      <span role="status" className="sr-only">
        Agent is thinking…
      </span>
      <span aria-hidden className="font-mono text-primary">
        {frame}
      </span>
      <span
        aria-hidden
        className={cn("text-foreground", !reduced && "animate-pulse")}
      >
        {word}
      </span>
      <span aria-hidden className="tabular-nums text-muted-foreground">
        · {elapsed}
      </span>
    </div>
  );
}
