"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

// 同标签页内 toggle 后手动派发（localStorage 的原生 storage 事件只在「其它标签页」触发）
const CHANGE_EVENT = "canvas-panel-collapsed-change";

export const PANEL_STORAGE_PREFIX = "canvas.panel.";

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * 画布侧栏折叠状态：缓存到 localStorage，刷新与跨标签页都保留。
 *
 * useSyncExternalStore（与 use-model-preference 同范式）：SSR 与首个客户端渲染都返回
 * false（展开），与服务端一致以避免水合不匹配；水合后读到本地存储值。不在 effect 里
 * setState，规避 Next16 lint。
 *
 * 折叠的**视觉表现**不看这个返回值，而看 `<html data-canvas-{left,right}>`——canvas/layout
 * 的预水合脚本在首屏绘制前就按缓存写好它，所以刷新不会闪现展开态。本 hook 负责水合后
 * 把两者持续对齐（含跨标签页的 storage 事件）。
 */
export function usePanelCollapsed(
  panel: "left" | "right",
): [boolean, () => void] {
  const key = `${PANEL_STORAGE_PREFIX}${panel}.collapsed`;
  const attr = panel === "left" ? "canvasLeft" : "canvasRight";

  const collapsed = useSyncExternalStore(
    subscribe,
    useCallback(() => localStorage.getItem(key) === "1", [key]),
    () => false,
  );

  useEffect(() => {
    document.documentElement.dataset[attr] = collapsed ? "collapsed" : "open";
  }, [attr, collapsed]);

  const toggle = useCallback(() => {
    localStorage.setItem(key, collapsed ? "0" : "1");
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [key, collapsed]);

  return [collapsed, toggle];
}
