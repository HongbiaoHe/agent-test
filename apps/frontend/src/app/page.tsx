import { Activity, ArrowRight, MessageSquare, Workflow } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { GlowBorder } from "@/components/ui/glow-border";

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

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <span>AgentSpark — an end-to-end Agent application skeleton.</span>
          <Link href="/login" className="hover:text-foreground">
            Sign in
          </Link>
        </div>
      </footer>
    </main>
  );
}
