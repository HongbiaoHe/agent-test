"use client";

import { useTheme as useNextTheme } from "next-themes";
import { useSyncExternalStore } from "react";

export type ThemeSetting = "light" | "dark";

const emptySubscribe = () => () => {};

/**
 * 两档主题：亮 ⇄ 暗 切换，不跟随系统。选择由 next-themes 持久化到 localStorage，
 * 刷新不丢失。
 *
 * mounted 守卫：next-themes 在水合前读不到本地存储值，theme 为 undefined。
 * 用 useSyncExternalStore 做水合检测——SSR 与首个客户端渲染都返回 false（让 UI
 * 渲染与服务端一致的占位），水合后返回 true。比 useEffect+setState 干净，且不触发
 * set-state-in-effect 的级联渲染。实际主题类由 next-themes 预水合脚本在首屏绘制前挂好，
 * 页面本身不闪烁。
 */
export function useTheme() {
  const { theme, setTheme } = useNextTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  // theme 仅取 dark/light；历史遗留的 "system" 等非法值归一到 light。
  const current: ThemeSetting = theme === "dark" ? "dark" : "light";

  return {
    theme: mounted ? current : undefined,
    // 函数式更新：基于最新值推进，避免连续点击时读到闭包里的旧 theme。
    cycle: () => setTheme((prev) => (prev === "dark" ? "light" : "dark")),
  };
}
