"use client";

import { useTheme } from "next-themes";
import { useMemo } from "react";

/**
 * Konva 画在 canvas 上，吃不到 CSS 变量：把需要的语义 token 在运行时读成具体颜色串
 * （仍来自 globals.css 的 :root / .dark，不在组件里写死颜色）。主题切换时重读。
 */
export interface StageColors {
  selection: string;
  agent: string;
  checkerA: string;
  checkerB: string;
  workspace: string;
  foreground: string;
  surface: string;
}

/** oklch() 等现代色值 canvas 2D 未必认：借一个 1px canvas 让浏览器转成 rgb。 */
function toCanvasColor(value: string): string {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return value;
  ctx.fillStyle = "#000";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

export function readStageColors(): StageColors {
  const style = getComputedStyle(document.documentElement);
  const read = (token: string) =>
    toCanvasColor(style.getPropertyValue(token).trim() || "rgba(128,128,128,1)");
  return {
    selection: read("--selection"),
    agent: read("--agent"),
    checkerA: read("--checker-a"),
    checkerB: read("--checker-b"),
    workspace: read("--workspace"),
    foreground: read("--foreground"),
    surface: read("--card"),
  };
}

/** resolvedTheme 变化即 .dark 已切换：随它重读（首帧主题未解析时返回 null）。 */
export function useStageColors(): StageColors | null {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme ? readStageColors() : null), [resolvedTheme]);
}
