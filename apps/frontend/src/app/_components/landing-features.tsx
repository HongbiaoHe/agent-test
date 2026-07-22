"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ArrowRight, Boxes, ShieldCheck, Workflow } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const features = [
  {
    icon: Workflow,
    title: "Planning & tool-calling",
    description:
      "Agents break work into steps and call the right tools — wired through deepagents, LangChain, and LangGraph.",
  },
  {
    icon: ShieldCheck,
    title: "Human-in-the-loop",
    description:
      "Pause on sensitive actions for approval, then resume exactly where the agent left off. Nothing runs unsupervised.",
  },
  {
    icon: Boxes,
    title: "Skills & sandbox",
    description:
      "Drop in reusable skills and run generated code in an isolated sandbox — safely, with media generation built in.",
  },
];

/**
 * 特性区：滚动进入视口时 GSAP 揭示（标题 → 卡片 stagger → CTA），卡片支持 hover 上浮。
 *
 * - 单条 timeline 挂一个 ScrollTrigger（动画放 timeline 上、不放子 tween，符合 ScrollTrigger 规范）。
 * - hover 用 useGSAP 提供的 contextSafe 包裹，卸载/重渲染时连同事件监听一并清理。
 * - 全部包在 matchMedia 的 no-preference 分支：减弱动效时不建动画/不绑监听，内容直接为最终态。
 */
export function LandingFeatures() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    (_context, contextSafe) => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({
            defaults: { ease: "power3.out" },
            scrollTrigger: { trigger: root.current, start: "top 75%" },
          })
          .from("[data-feature='intro'] > *", {
            y: 24,
            opacity: 0,
            duration: 0.6,
            stagger: 0.12,
          })
          .from(
            "[data-feature='card']",
            { y: 32, opacity: 0, duration: 0.6, stagger: 0.12 },
            "-=0.2",
          )
          .from(
            "[data-feature='cta']",
            { y: 16, opacity: 0, duration: 0.5 },
            "-=0.2",
          );

        // 卡片 hover 上浮：contextSafe 确保 tween 进入上下文、卸载随之清理；
        // 监听器在本分支 revert 时手动移除。
        if (!contextSafe) return;
        const cards = gsap.utils.toArray<HTMLElement>("[data-feature='card']");
        const detach = cards.map((card) => {
          const enter = contextSafe(() =>
            gsap.to(card, {
              y: -6,
              duration: 0.3,
              ease: "power2.out",
              overwrite: "auto",
            }),
          );
          const leave = contextSafe(() =>
            gsap.to(card, {
              y: 0,
              duration: 0.3,
              ease: "power2.out",
              overwrite: "auto",
            }),
          );
          card.addEventListener("mouseenter", enter);
          card.addEventListener("mouseleave", leave);
          return () => {
            card.removeEventListener("mouseenter", enter);
            card.removeEventListener("mouseleave", leave);
          };
        });
        return () => detach.forEach((off) => off());
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section
      ref={root}
      id="features"
      className="mx-auto w-full max-w-6xl scroll-mt-16 px-4 py-20 sm:px-6 sm:py-28"
    >
      <div data-feature="intro" className="mx-auto max-w-2xl text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          A runnable Agent skeleton, not a demo
        </h2>
        <p className="mt-3 text-pretty text-muted-foreground">
          Everything you need to wire up an agent and watch it work —
          end-to-end, in one place.
        </p>
      </div>

      <div data-feature="grid" className="mt-12 grid gap-4 sm:grid-cols-3">
        {features.map(({ icon: Icon, title, description }) => (
          <Card key={title} data-feature="card" className="h-full">
            <CardHeader>
              <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Icon className="size-5" />
              </span>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <div data-feature="cta" className="mt-12 flex justify-center">
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/login" />}
        >
          Start building
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </section>
  );
}
