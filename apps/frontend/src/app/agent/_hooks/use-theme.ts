"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * 轻量明暗切换：在 <html> 上挂 .dark 类，配合 globals.css 的 @custom-variant。
 * 初始从 <html> 的 .dark 类读取——它不在路由重挂载子树内（<html> 不被卸载），
 * 故切换 /agent ↔ /agent/[id] 后主题保持；SSR/首次水合时类为浅色、与服务端一致，无水合告警。
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")),
  };
}
