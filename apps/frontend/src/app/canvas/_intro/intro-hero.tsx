"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { ThinkingGrid } from "../_components/thinking-indicator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AGENT_FACES } from "./agent-faces";

/**
 * 每一档在台上停多久（ms）。取值有下限：至少覆盖该动画走完一整轮，
 * 否则观众看到的是半句话。各档实际周期（globals.css）：
 *   pulse   duration 1.32–1.78s，delay ≤1.02s
 *   wave    duration 1.3s + 最大 delay 0.52s ≈ 1.8s
 *   orbit   duration 1.6s + 最大 delay 1.4s ≈ 3.0s
 *   standby duration 4.5s + 最大 delay 0.55s ≈ 5.05s
 */
const HOLD_MS: Record<string, number> = {
  thinking: 3600,
  working: 3200,
  loading: 4000,
  standby: 5600,
};

/**
 * 是否要求减弱动效。用 useSyncExternalStore 订阅 matchMedia（同 use-is-mobile 的范式）：
 * 不在 effect 里 setState，规避 Next16 的 react-hooks/set-state-in-effect（error 级）。
 * SSR 与首个客户端渲染都返回 false，水合后立即读真值。
 */
function useReducedMotion(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    mql.addEventListener("change", cb);
    return () => mql.removeEventListener("change", cb);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/**
 * 首屏：一个放大的方阵轮着演四种状态，下面用 mono 一行报出它此刻是哪一档。
 *
 * 为什么轮播而不是并排放四个：这一页的第一句话是「它是活的」，四个同时动会读成
 * 一张规格图（并排对照留给下面的 States 区）。轮播则是同一个角色在换表情——
 * 正是产品里的实际行为：画布上永远只有这一个方阵，它换的是节律。
 *
 * 四个 chip 既是图例也是遥控器：点一下停在那一档，键盘用户也能挨个比较。
 * 要求减弱动效时不自动轮播（这一页是常驻页，自动换档停不下来就是长期干扰），
 * 但 chip 照旧可用——动画本身就是这一页要讲的东西，全冻住页面就没内容了。
 */
export function IntroHero({ isLoggedIn }: { isLoggedIn: boolean }) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  // 一旦手动挑过就不再自动走：刚点完又被定时器顶掉，读起来像点漏了
  const [pinned, setPinned] = useState(false);
  const face = AGENT_FACES[index];

  useEffect(() => {
    if (pinned || reduced) return;
    const timer = setTimeout(
      () => setIndex((i) => (i + 1) % AGENT_FACES.length),
      HOLD_MS[AGENT_FACES[index].key] ?? 4000,
    );
    return () => clearTimeout(timer);
  }, [index, pinned, reduced]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-6 pb-16 pt-14 text-center md:pt-20">
      <span
        className="landing-rise font-mono text-xs tracking-wide text-muted-foreground"
        style={{ animationDelay: "0s" }}
      >
        canvas · a tour in nine squares
      </span>

      {/* 方阵：这一页唯一的主角，所以给到 168px（聊天流里它只有 18px）。
          光晕会外扩约 0.37×size，容器留出 py 让它不被裁 */}
      <div
        className="landing-rise flex h-64 items-center justify-center"
        style={{ animationDelay: "0.06s" }}
      >
        <ThinkingGrid
          size={168}
          animation={face.animation}
          // gap 只在这一处加：产品里的方阵是 18–24px，九格靠明暗差就分得清；
          // 放大到 168px 后同亮度的相邻格会连成一整块，标题说的「nine squares」就看不见了。
          // 3px 的缝够读出九格，又不至于散成九个互不相干的点。
          // canvas-thinking-instant 把错峰 delay 归零：pulse 的 delay 最长 1.02s，
          // 换档后干等一秒才动会让人以为点了没反应。
          className="canvas-thinking-instant gap-[3px]"
        />
      </div>

      <div
        className="landing-rise flex flex-col items-center gap-3"
        style={{ animationDelay: "0.12s" }}
      >
        {/* 图例 + 遥控器。role=status 让读屏在自动换档时也能播报当前档位 */}
        <div className="flex flex-wrap justify-center gap-1">
          {AGENT_FACES.map((f, i) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setIndex(i);
                setPinned(true);
              }}
              aria-pressed={i === index}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors duration-200",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                "motion-reduce:transition-none",
                i === index
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.animation}
            </button>
          ))}
        </div>
        <p
          className="max-w-md text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span className="font-medium text-foreground">{face.name}</span> —{" "}
          {face.rhythm}
        </p>
      </div>

      <h1
        className="landing-rise mt-10 text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl"
        style={{ animationDelay: "0.18s" }}
      >
        Nine squares. One picture. One agent.
      </h1>

      <p
        className="landing-rise mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg"
        style={{ animationDelay: "0.24s" }}
      >
        Zoom far enough into anything this canvas makes and you land on a single
        square. Nine of them are a frame; frames in a row are a shot. The same
        nine squares are the face of the agent that draws them — and the way
        they move tells you exactly what it is up to.
      </p>

      <div
        className="landing-rise mt-9 flex flex-col items-center gap-3 sm:flex-row"
        style={{ animationDelay: "0.3s" }}
      >
        <Button
          size="lg"
          nativeButton={false}
          render={
            <Link
              href={isLoggedIn ? "/canvas-list" : "/login?next=/canvas-list"}
            />
          }
        >
          {isLoggedIn ? "Open your canvases" : "Sign in to try it"}
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="lg"
          variant="outline"
          nativeButton={false}
          render={<a href="#make" />}
        >
          What it makes
        </Button>
      </div>
    </div>
  );
}
