"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  type ThinkingLevel,
  asThinkingLevel,
  supportsThinkingLevel,
} from "@/lib/thinking-level";

const STORAGE_KEY = "agent.thinking";
// 同标签页内 setLevel 后手动派发（localStorage 的原生 storage 事件只在「其它标签页」触发）
const CHANGE_EVENT = "agent-thinking-change";

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): ThinkingLevel {
  return asThinkingLevel(localStorage.getItem(STORAGE_KEY)) ?? "auto";
}

/**
 * 思考深度偏好：与 useModelPreference 同范式（localStorage + useSyncExternalStore，SSR 首帧返回 auto）。
 *
 * 存的是用户最后一次的选择，**不随换模型改写**；返回的是对当前模型生效的档位——
 * 当前模型不支持（如 DeepSeek 选了 High）就回落 auto。这样从 DeepSeek 切回 Gemini 时，
 * 之前选的 High 会自动回来，而不是被一次换模型永久冲掉。
 */
export function useThinkingPreference(
  model: string,
): [ThinkingLevel, (level: ThinkingLevel) => void] {
  const stored = useSyncExternalStore(subscribe, getSnapshot, () => "auto" as const);
  const level = supportsThinkingLevel(model, stored) ? stored : "auto";

  const setLevel = useCallback((next: ThinkingLevel) => {
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [level, setLevel];
}
