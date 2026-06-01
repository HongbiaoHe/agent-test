"use client";

import { useTheme as useNextTheme } from "next-themes";
import { useSyncExternalStore } from "react";

export type ThemeSetting = "system" | "light" | "dark";

const ORDER: ThemeSetting[] = ["system", "light", "dark"];

const emptySubscribe = () => () => {};

/**
 * 三档主题：系统 → 亮 → 暗 循环切换。选择由 next-themes 持久化到 localStorage，
 * 刷新不丢失；"系统"档实时跟随 OS 的 prefers-color-scheme 变化。
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

  return {
    theme: (mounted ? theme : undefined) as ThemeSetting | undefined,
    // 函数式更新：基于最新值推进，避免连续点击时读到闭包里的旧 theme。
    cycle: () =>
      setTheme((prev) => {
        const idx = ORDER.indexOf(prev as ThemeSetting);
        return ORDER[(idx + 1) % ORDER.length];
      }),
  };
}
