import { Activity, ArrowDown, ArrowRight, Bot, Box, FileCheck, Film, GitBranch, Grid3x3, Image as ImageIcon, Layers, Link2, MessageSquare, Network, Play, Repeat, Sparkles, Type, Wifi, Workflow, Zap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { GlowBorder } from "@/components/ui/glow-border";

import { ThinkingGrid } from "./canvas/_components/thinking-indicator";

import DotField from "./_components/dot-field";
import { LandingFeatures } from "./_components/landing-features";
import { LandingHero } from "./_components/landing-hero";
import { LandingNav } from "./_components/landing-nav";
import { ScrollReveal } from "./_components/scroll-reveal";

export const metadata: Metadata = {
  title: "AgentSpark — Build agents that feel alive",
  description:
    "An end-to-end Agent platform: planning, tool-calling, human-in-the-loop, skills, and real-time streaming — wired up and ready to run.",
};

const steps = [
  {
    icon: MessageSquare,
    title: "Describe the task",
    description:
      "Tell the agent what you want in plain language — no rigid commands, no setup ceremony.",
  },
  {
    icon: Workflow,
    title: "It plans & acts",
    description:
      "The agent breaks the goal into steps and calls the right tools, pausing for your approval on anything sensitive.",
  },
  {
    icon: Activity,
    title: "Watch it stream",
    description:
      "Reasoning, tool calls, and results stream back live over WebSocket — nothing happens behind a curtain.",
  },
];

/** 画布区的三条要点：与实际实现一致（端口契约 / 素材全靠入边 / agent 代搭）。 */
const canvasPoints = [
  {
    icon: Network,
    title: "Typed nodes, typed edges",
    description:
      "Every node declares what it accepts and what it produces. Text feeds a generator; a generator feeds the next one. Invalid wiring is refused before it reaches the queue.",
  },
  {
    icon: Link2,
    title: "Inputs are the prompt",
    description:
      "A generation node carries no prompt field of its own. It reads the prompt and the reference frames from whatever you connect upstream, so editing one text node re-aims everything downstream.",
  },
  {
    icon: Bot,
    title: "Let the agent wire it",
    description:
      "Describe the pipeline in a sentence. The agent places the nodes, connects them, triggers generation, and you watch the cards fill in over the same live stream.",
  },
  {
    icon: Grid3x3,
    title: "It has a face, and it tells you things",
    description:
      "The agent shows up as a 3×3 grid of squares — the same nine squares a generated frame is made of. Thinking, working, orienting, idle: each state has its own rhythm, so a glance tells you whether it is stuck or still going.",
  },
];

/** 画布区右栏的流程示意（不是产品截图，是三类节点如何串起来的图示）。 */
const canvasFlow = [
  { icon: Type, label: "Text", detail: "The prompt" },
  { icon: ImageIcon, label: "Image", detail: "Generated, or uploaded" },
  { icon: Film, label: "Video", detail: "Upstream images go in as reference" },
];

const stack = [
  { name: "deepagents · LangGraph", role: "Agent core" },
  { name: "Gemini · DeepSeek", role: "LLM" },
  { name: "NestJS", role: "API & workers" },
  { name: "Prisma · MySQL", role: "Persistence" },
  { name: "Redis · BullMQ", role: "Queue & event stream" },
  { name: "Next.js", role: "Frontend" },
  { name: "LangSmith", role: "Tracing & observability" },
  { name: "next-auth", role: "Auth & session" },
  { name: "Daytona", role: "Skill sandbox" },
];

export default async function HomePage() {
  // 服务端取登录态：SSR 直出正确的导航 CTA（Workspace / Sign in），无客户端闪烁。
  const session = await auth();
  const isLoggedIn = Boolean(session?.user);

  return (
    <main className="flex flex-1 flex-col bg-background">
      {/* Hero：满屏点阵背景 + 居中文案 + 双 CTA。用 min-h-screen（静态 100vh）而非 dvh，
          避免预览环境里 dvh 动态重算导致整页塌顶。 */}
      <section className="relative min-h-screen overflow-clip">
        <DotField className="absolute inset-0 z-0" />
        {/* 中心柔化遮罩：仅在文案正后方轻收一圈，保证标题可读，又不过度盖住点阵。 */}
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            backgroundImage:
              "radial-gradient(45% 38% at 50% 42%, var(--background) 0%, transparent 70%)",
          }}
        />

        <LandingNav isLoggedIn={isLoggedIn} />
        <LandingHero />
      </section>

      <LandingFeatures />

      {/* How it works：从一句话到一个在跑的 agent。 */}
      <ScrollReveal
        id="how"
        className="border-t border-border bg-muted/30"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div data-reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              From a prompt to a running agent
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Three steps — and you stay in control the whole way through.
            </p>
          </div>

          <ol className="mt-12 grid gap-4 sm:grid-cols-3">
            {steps.map(({ icon: Icon, title, description }, i) => (
              <li
                key={title}
                data-reveal
                className="rounded-xl border border-border bg-card p-6"
              >
                <div className="mb-4 flex items-center justify-between">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <Icon className="size-5" />
                  </span>
                  <span className="font-mono text-sm text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="font-medium">{title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {description}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </ScrollReveal>

      {/* Canvas：唯一的左右分栏区块（其余区块都是居中标题 + 卡片网格，不再重复同一种版式）。
          右栏是三类节点如何串起来的流程图示，不是伪造的产品截图。 */}
      <ScrollReveal id="canvas" className="border-t border-border bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="grid items-start gap-12 lg:grid-cols-[1fr_22rem] lg:gap-16">
            {/* 左：文案 + 要点 + 入口 */}
            <div>
              <h2
                data-reveal
                className="text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                Wire the workflow on a canvas
              </h2>
              <p
                data-reveal
                className="mt-3 max-w-xl text-pretty text-muted-foreground"
              >
                Text, image, and video nodes on one board. Connect them and the
                prompt and reference frames flow downstream on their own.
              </p>

              <ul className="mt-10 space-y-6">
                {canvasPoints.map(({ icon: Icon, title, description }) => (
                  <li key={title} data-reveal className="flex gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-medium">{title}</h3>
                      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
                        {description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              {/* 两个入口，按登录态换主次：
                  已登录的人要的是自己的画布（/canvas-list），介绍页退成次级；
                  没登录的人先看介绍页（它是公开的，不用先注册），登录才是次级。 */}
              <div
                data-reveal
                className="mt-10 flex flex-col gap-3 sm:flex-row"
              >
                {isLoggedIn ? (
                  <>
                    <Button
                      size="lg"
                      nativeButton={false}
                      render={<Link href="/canvas-list" />}
                    >
                      Open your canvases
                      <ArrowRight className="size-4" />
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      nativeButton={false}
                      render={<Link href="/canvas" />}
                    >
                      Canvas tour
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="lg"
                      nativeButton={false}
                      render={<Link href="/canvas" />}
                    >
                      Canvas tour
                      <ArrowRight className="size-4" />
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      nativeButton={false}
                      render={<Link href="/login?next=/canvas-list" />}
                    >
                      Sign in to try it
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* 右：流程图示 */}
            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-6"
            >
              <ol className="space-y-1">
                {canvasFlow.map(({ icon: Icon, label, detail }, i) => (
                  <li key={label}>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                        <Icon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{label}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {detail}
                        </div>
                      </div>
                    </div>
                    {/* 连接符：最后一个节点后面不画 */}
                    {i < canvasFlow.length - 1 && (
                      <div
                        className="flex justify-center py-1 text-muted-foreground"
                        aria-hidden
                      >
                        <ArrowDown className="size-4" />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-xs text-muted-foreground">
                Nodes stay editable while the agent works, and every change
                broadcasts to anyone else watching the same board.
              </p>

              {/* Agent 本尊在首页露一次脸：待机灯（这里没有 agent 在跑，只有它在等）。
                  真组件而不是截图——它现在就在动，一句话都不用解释「活着」是什么意思。 */}
              <div className="mt-5 flex items-center gap-3 border-t border-border pt-4">
                {/* gap-px：18–20px 下九格靠明暗差本来就分得清，但这句话点名了「nine squares」，
                    加一道 1px 缝，静止看也数得出九格（画布里的方阵不加缝，那里有动画带着读） */}
                <ThinkingGrid size={20} animation="standby" className="gap-px" />
                <p className="min-w-0 text-xs text-muted-foreground">
                  Standing by. The rhythm of those nine squares is the agent&apos;s
                  status —{" "}
                  <Link
                    href="/canvas#states"
                    className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground motion-reduce:transition-none"
                  >
                    see all four
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </ScrollReveal>

      {/* Built on a real stack：诚实列出端到端用到的技术。 */}
      <ScrollReveal className="border-t border-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div data-reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Built on a real stack
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Not a toy demo — an end-to-end skeleton you can clone and run.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {stack.map(({ name, role }) => (
              <div
                key={name}
                data-reveal
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="font-medium">{name}</div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {role}
                </div>
              </div>
            ))}
          </div>
        </div>
      </ScrollReveal>

      {/* Real-time streaming · why WebSocket + Redis Stream：双向通信、水平扩展、传输层降级。 */}
      <ScrollReveal className="border-t border-border bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div data-reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Streaming &middot; why WebSocket
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              Not SSE, not polling — a dual-channel architecture built for
              real-time agent interactions.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Zap className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Dual-channel, not SSE</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    REST for mutations (create, append, stop), Socket.IO for
                    real-time events (tokens, tools, plans, approvals). SSE is
                    one-way — here the approval &amp; subscription handshake
                    share the same wire.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Layers className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Redis Stream decouples workers</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    Workers write events to Redis Stream (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">XADD</code>), the
                    gateway consumes them (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">XREAD</code>). Add more workers or
                    more gateway instances — they never need to know about each
                    other.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Repeat className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Bidirectional on one connection</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    Approval decisions (<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">control:response</code>), conversation
                    subscriptions, and real-time events all flow over the same
                    persistent WebSocket. SSE would need separate HTTP POSTs for
                    every client-to-server message.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Wifi className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Transport resilience</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    Socket.IO auto-falls back to HTTP long-polling when
                    WebSocket upgrades fail — critical behind corporate proxies
                    and in dev environments (Next.js dev server). SSE gives up
                    when the first connection fails.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScrollReveal>

      {/* Monorepo · why it works：pnpm workspace 相比分散仓库的核心优势 */}
      <ScrollReveal className="border-t border-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div data-reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Monorepo &middot; why it works
            </h2>
            <p className="mt-3 text-pretty text-muted-foreground">
              One pnpm workspace replaces two disjoint repos — no drift, no
              coordination tax, no duplicated config.
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <FileCheck className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">One lockfile, zero drift</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    A single <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pnpm-lock.yaml</code>{" "}
                    keeps backend &amp; frontend dependencies in sync. In a
                    multi-repo setup they would diverge silently — here they
                    never can.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <GitBranch className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Atomic cross-package changes</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    Refactor a schema, update the API, rewire the frontend —
                    all in one commit. No cross-repo PR dance, no&nbsp;version
                    bumps, no&nbsp;coordination overhead.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Box className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">Config once, inherit everywhere</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    TypeScript, ESLint, CI — defined at the root, inherited by
                    every workspace package. In multi-repo every project
                    duplicates its own config and drifts out of sync.
                  </div>
                </div>
              </div>
            </div>

            <div
              data-reveal
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Play className="size-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium">One command to run it all</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">pnpm dev</code> fires up both
                    servers via PM2. No tab-switching, no separate terminals,
                    no &ldquo;which repo do I start first?&rdquo; — just one process tree.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScrollReveal>

      {/* Final CTA：用 GlowBorder 强调收口。 */}
      <ScrollReveal className="border-t border-border bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <GlowBorder
            data-reveal
            className="mx-auto max-w-2xl bg-card p-10 text-center sm:p-14"
          >
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to build your agent?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-pretty text-muted-foreground">
              Sign in and you&apos;re in the workspace — wire up an agent and
              watch it run.
            </p>
            <div className="mt-8 flex justify-center">
              <Button
                size="lg"
                nativeButton={false}
                render={<Link href="/login" />}
              >
                Get started
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </GlowBorder>
        </div>
      </ScrollReveal>

      <footer className="border-t border-border bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="grid gap-8 sm:grid-cols-3">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Sparkles className="size-4" />
                </div>
                <span className="text-sm font-semibold tracking-tight">
                  AgentSpark
                </span>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                An end-to-end Agent application skeleton — planning,
                tool-calling, human-in-the-loop, skills, and real-time
                streaming.
              </p>
            </div>

            {/* Framework links */}
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Powered by
              </h3>
              <ul className="space-y-2 text-sm">
                {[
                  ["deepagents (LangGraph)", "https://langchain-ai.github.io/langgraphjs/"],
                  ["Gemini / DeepSeek", "https://deepmind.google/gemini/"],
                  ["NestJS", "https://nestjs.com/"],
                  ["Next.js", "https://nextjs.org/"],
                  ["Prisma · MySQL", "https://prisma.io/"],
                  ["Redis · BullMQ", "https://redis.io/"],
                  ["LangSmith", "https://smith.langchain.com/"],
                  ["Daytona", "https://daytona.io/"],
                ].map(([name, href]) => (
                  <li key={name}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Resources */}
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Links
              </h3>
              <ul className="space-y-2 text-sm">
                <li>
                  {/* 介绍页是公开的（middleware 只放行精确 /canvas），页脚照直链就行 */}
                  <Link
                    href="/canvas"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Canvas tour
                  </Link>
                </li>
                <li>
                  <Link
                    href="/login"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Sign in
                  </Link>
                </li>
                <li>
                  <a
                    href="https://next-auth.js.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    next-auth docs
                  </a>
                </li>
                <li>
                  <a
                    href="https://ui.shadcn.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    shadcn/ui
                  </a>
                </li>
                <li>
                  <a
                    href="https://tailwindcss.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Tailwind CSS
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-10 border-t border-border pt-6 text-center text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} AgentSpark. An open-source
            demonstration project.
          </div>
        </div>
      </footer>
    </main>
  );
}
