import { ArrowRight, ArrowUpRight, FlaskConical } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Button } from "@/components/ui/button";

const tags = ["Three.js", "Cel-shaded", "Miniature", "Assembly"];

/**
 * 首页的 Lab 入口区。
 *
 * Lab 是产品之外的「实验展架」：agent 实现的独立页面、全屏、无宿主 UI。
 * 首页给一个可视化入口 + 分类说明，避免实验页面只能靠记 URL 访问。
 */
export function LandingLab() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <div data-reveal className="mx-auto max-w-2xl text-center">
        <p className="inline-flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <FlaskConical className="size-3.5" />
          </span>
          AgentSpark Lab
        </p>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          A shelf for agent-built pages
        </h2>
        <p className="mt-3 text-pretty text-muted-foreground">
          Not everything belongs in the product. The lab collects standalone
          page experiments — visual, interactive, or just strange — each one a
          full-screen route with no host UI around it.
        </p>
      </div>

      <div
        data-reveal
        className="mt-12 overflow-hidden rounded-xl border border-border bg-card md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
      >
        <Link
          href="/lab/rainy-store"
          className="group relative block aspect-16/10 overflow-hidden bg-muted md:aspect-auto md:min-h-80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Image
            src="/lab/rainy-store.jpg"
            alt="Rainy-night Japanese convenience store diorama on a square plinth"
            fill
            sizes="(min-width: 768px) 55vw, 100vw"
            className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
          <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-4xl border border-border/60 bg-background/80 px-2.5 py-1 text-xs font-medium text-foreground backdrop-blur-md">
            <span className="size-1.5 rounded-full bg-primary" />
            #001 &middot; 3D scene
          </span>
        </Link>

        <div className="flex flex-col justify-between gap-6 p-6 sm:p-8">
          <div>
            <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              Latest experiment
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-tight">
              Rainy-night konbini street corner
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              A collectible 12&times;12 diorama: cel-shaded night, rain, neon
              reflections, and an assembly animation that builds the block from
              the ground up. Drag to orbit, scroll to zoom.
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-4xl border border-border px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              nativeButton={false}
              render={<Link href="/lab" />}
            >
              Open the lab
              <ArrowUpRight className="size-4" />
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href="/lab/rainy-store" />}
            >
              View this scene
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <p data-reveal className="mt-6 text-center text-xs text-muted-foreground">
        New experiments are registered in the lab index — one route per
        experiment, kept out of the product flow.
      </p>
    </div>
  );
}
