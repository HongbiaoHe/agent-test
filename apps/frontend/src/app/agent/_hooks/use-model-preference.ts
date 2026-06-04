"use client";

import { useCallback, useSyncExternalStore } from "react";

import { DEFAULT_MODEL, MODEL_OPTIONS } from "../_lib/models";

const STORAGE_KEY = "agent.model";
// 同标签页内 setModel 后手动派发（localStorage 的原生 storage 事件只在「其它标签页」触发）
const CHANGE_EVENT = "agent-model-change";

function isValid(v: string | null): v is string {
  return !!v && MODEL_OPTIONS.some((m) => m.value === v);
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): string {
  const v = localStorage.getItem(STORAGE_KEY);
  // 旧的/非法存值（白名单变动后）回退默认，避免发出已下线的模型
  return isValid(v) ? v : DEFAULT_MODEL;
}

/**
 * 模型偏好：选择缓存到 localStorage，刷新与跨标签页都保留。
 *
 * useSyncExternalStore（与 use-theme 同范式）：SSR 与首个客户端渲染都返回 DEFAULT_MODEL，
 * 与服务端一致以避免水合不匹配；水合后读到本地存储值。setModel 写入后派发自定义事件通知
 * 本标签页订阅者（原生 storage 事件仅跨标签页触发）。不在 effect 里 setState，规避 Next16 lint。
 */
export function useModelPreference(): [string, (model: string) => void] {
  const model = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => DEFAULT_MODEL,
  );

  const setModel = useCallback((next: string) => {
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return [model, setModel];
}
