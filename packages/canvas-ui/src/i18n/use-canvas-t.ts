"use client";

import { useCanvasPlatform } from "../platform";
import { CANVAS_MESSAGES, type CanvasMessages } from "./messages";

/** 当前语言的画布字典（语言来自 CanvasPlatformProvider 的 locale）。 */
export function useCanvasT(): CanvasMessages {
  return CANVAS_MESSAGES[useCanvasPlatform().locale];
}
