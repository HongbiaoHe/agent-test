import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, Box } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { LAB_ENTRIES } from "./_data/implementations";

export const metadata: Metadata = {
  title: "Lab · 页面效果实验场 | AgentSpark",
  description:
    "用来验收 agent 实现的独立页面效果：全屏成品，不套宿主 UI。",
};

/**
 * Lab 索引页：只负责「登记 + 预览 + 入口」。
 * 每个实现都是独立路由的全屏页面，索引页本身遵循 manus 暖中性设计系统。
 */
export default function LabPage() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-6 py-12 md:px-8 md:py-20">
        <header className="border-b border-border pb-8">
          <p className="flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-primary" />
            AgentSpark Lab
          </p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-4xl">
            页面效果实验场
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            专门用来验收 agent 实现的页面效果。每个条目都是一个可直接打开的全屏成品，
            不套宿主框架 UI；索引只负责登记、预览和入口，避免实验页面污染产品主流程。
          </p>
        </header>

        <section className="mt-10">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium">实现清单</h2>
            <span className="font-mono text-xs text-muted-foreground">
              {LAB_ENTRIES.length} {LAB_ENTRIES.length === 1 ? "page" : "pages"}
            </span>
          </div>

          <ul className="mt-4 grid gap-5 sm:grid-cols-2">
            {LAB_ENTRIES.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={entry.href}
                  className="group block h-full overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <div className="relative aspect-16/10 overflow-hidden bg-muted">
                    {entry.preview ? (
                      <Image
                        src={entry.preview}
                        alt={`${entry.title} 预览`}
                        fill
                        loading="eager"
                        sizes="(min-width: 640px) 50vw, 100vw"
                        className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Box className="size-8 text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  <div className="p-5">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{entry.category}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        #{entry.id}
                      </span>
                    </div>
                    <h3 className="mt-3 flex items-center justify-between gap-3 text-base font-medium">
                      {entry.title}
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {entry.description}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {entry.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <footer className="mt-16 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
          新增实现：在 <code className="font-mono">src/app/lab/</code> 下建独立路由，
          再把条目登记到{" "}
          <code className="font-mono">src/app/lab/_data/implementations.ts</code>。
          本模块不要求登录。
        </footer>
      </div>
    </main>
  );
}
