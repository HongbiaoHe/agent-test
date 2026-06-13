"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { ThemeToggle } from "./theme-toggle";

const subscribeScroll = (cb: () => void) => {
  window.addEventListener("scroll", cb, { passive: true });
  return () => window.removeEventListener("scroll", cb);
};

/**
 * 订阅滚动位置，派生「是否已滚过阈值」布尔。
 * 用 useSyncExternalStore：SSR/首帧返回 false（顶部胶囊态），不触发 set-state-in-effect；
 * 返回原始布尔，仅在跨阈值时才重渲染。
 */
function useScrolled(threshold: number) {
  return useSyncExternalStore(
    subscribeScroll,
    () => window.scrollY > threshold,
    () => false,
  );
}

/**
 * 落地页悬浮胶囊导航（毛玻璃）。
 *
 * - sticky：fixed 吸顶，始终可见。
 * - 滚动展开动画：顶部为居中胶囊（max-w-5xl + rounded-4xl + 上边距；用等于半高的具体圆角值
 *   而非 rounded-full，圆角才能随滚动平滑过渡到 0，不会瞬切），滚过阈值后
 *   动画撑满屏幕成整条 bar（max-w-full + rounded-none + 贴顶 + 底边线），内层 max-w-5xl
 *   始终居中——故「导航条撑满屏幕、内容保持居中」。motion-safe 下才过渡，尊重 reduced-motion。
 * - 配色走语义 token（§7），亮暗自适应；auth-aware：登录显示 Workspace、未登录显示 Sign in；
 *   移动端隐藏次级锚点链接。
 */
export function LandingNav({ isLoggedIn }: { isLoggedIn: boolean }) {
  const scrolled = useScrolled(24);

  return (
    <header className="fixed inset-x-0 top-0 z-30">
      <div
        className={cn(
          // light 模式不投影（去掉浮于浅底上的灰影），仅暗色保留 shadow-lg 增强分层
          "mx-auto flex items-center border-border bg-card/55 backdrop-blur-xl duration-500 ease-out motion-safe:transition-all dark:shadow-lg",
          scrolled
            ? "mt-0 h-14 w-full max-w-full rounded-none border-b bg-card/75"
            : "mt-4 h-14 w-[calc(100%-2rem)] max-w-5xl rounded-4xl border sm:mt-5 sm:h-16",
        )}
      >
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 sm:px-5">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="size-4" />
            </span>
            AgentSpark
          </Link>

          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="hidden rounded-full sm:inline-flex"
              nativeButton={false}
              render={<a href="#features" />}
            >
              Features
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="hidden rounded-full sm:inline-flex"
              nativeButton={false}
              render={<a href="#how" />}
            >
              How it works
            </Button>
            <ThemeToggle />
            {isLoggedIn ? (
              <Button
                className="rounded-full px-4"
                nativeButton={false}
                render={<Link href="/agent" />}
              >
                Workspace
              </Button>
            ) : (
              <Button
                className="rounded-full px-4"
                nativeButton={false}
                render={<Link href="/login" />}
              >
                Sign in
              </Button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
