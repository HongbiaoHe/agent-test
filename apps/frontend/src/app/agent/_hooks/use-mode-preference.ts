"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "agent.mode";
// 同标签页内 setModeId 后手动派发（localStorage 的原生 storage 事件只在「其它标签页」触发）
const CHANGE_EVENT = "agent-mode-change";

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): string | null {
  return localStorage.getItem(STORAGE_KEY) || null;
}

/**
 * 模式偏好：最近一次使用的模式 id（null = 通用模式），缓存到 localStorage，供新建会话时带上。
 * 与 useModelPreference 同范式（useSyncExternalStore，SSR 首帧返回 null）。
 * 存的 id 可能已被删除——用的地方要先在模式列表里核对，查不到就当通用模式。
 */
export function useModePreference(): [string | null, (modeId: string | null) => void] {
  const modeId = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const setModeId = useCallback((next: string | null) => {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [modeId, setModeId];
}
