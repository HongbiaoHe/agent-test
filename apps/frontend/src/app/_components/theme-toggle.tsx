"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const emptySubscribe = () => () => {};

/**
 * 亮/暗切换按钮（基于 next-themes）。
 *
 * mounted 守卫用 useSyncExternalStore：SSR 与首个客户端渲染都返回 false，
 * 渲染与服务端一致的占位图标，避免读不到 resolvedTheme 造成的水合不一致
 * （也规避 set-state-in-effect）。真实主题类由 next-themes 预水合脚本挂好，不闪烁。
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={isDark ? "切换到浅色" : "切换到暗色"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  );
}
