import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Hero 文案 + 双 CTA。入场用纯 CSS 动画（.landing-rise + animation-delay 错峰），
 * 不依赖 JS 水合：SSR 首帧即渲染最终结构、由 CSS 在首帧前置好隐藏态并自动淡入上滑，
 * 故慢加载不白屏、也不闪现，与客户端完美衔接。reduced-motion 下保持自然可见态。
 *
 * 因不再用 GSAP，本组件是纯 server 组件（无需 'use client'），对 SSR 最友好。
 */
export function LandingHero() {
  return (
    <div className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-4 text-center sm:px-6">
      <span
        className="landing-rise mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm"
        style={{ animationDelay: "0s" }}
      >
        <span className="flex items-center rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-wide text-primary-foreground">
          NEW
        </span>
        Skills &amp; sandboxed media generation
      </span>

      <h1
        className="landing-rise text-balance text-4xl font-semibold tracking-tight sm:text-6xl"
        style={{ animationDelay: "0.08s" }}
      >
        Build agents that feel alive
      </h1>

      <p
        className="landing-rise mt-5 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg"
        style={{ animationDelay: "0.16s" }}
      >
        An end-to-end Agent platform — planning, tool-calling,
        human-in-the-loop, skills, and real-time streaming, all wired up and
        ready to run.
      </p>

      <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/login" />}
          className="landing-rise"
          style={{ animationDelay: "0.24s" }}
        >
          Get started
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="lg"
          variant="outline"
          nativeButton={false}
          render={<a href="#features" />}
          className="landing-rise"
          style={{ animationDelay: "0.32s" }}
        >
          Learn more
        </Button>
      </div>
    </div>
  );
}
