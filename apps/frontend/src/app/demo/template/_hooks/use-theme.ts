"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * 轻量明暗切换：在 <html> 上挂 .dark 类，配合 globals.css 的 @custom-variant。
 * 初始固定浅色（manus 默认），保证 SSR 与首屏一致；切换仅在当前会话生效。
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")),
  };
}
