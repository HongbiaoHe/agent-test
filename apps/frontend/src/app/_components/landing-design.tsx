import { ArrowRight, Image as ImageIcon, Layers, ScissorsLineDashed, Type, Wand2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * 首页的分图层设计（/design）入口区。
 *
 * 左栏是一份图层清单示意：按 agent 真实产出的一张海报整理（名称译成英文）（整图生成 → 拆层 → 普通文字换成可编辑文字），
 * 不是伪造的产品截图；右栏三条要点与实现一致，外加按登录态切换的入口。
 */
const layers = [
  { kind: "text", name: "Offer headline", detail: "Noto Serif SC · 46px" },
  { kind: "text", name: "Store address", detail: "Noto Sans SC · 19px" },
  { kind: "image", name: "Title lettering", detail: "Kept as artwork" },
  { kind: "image", name: "Maple oat latte", detail: "Transparent PNG" },
  { kind: "image", name: "Ginkgo leaves", detail: "Transparent PNG" },
  { kind: "image", name: "Warm backdrop", detail: "Base layer" },
] as const;

const points = [
  {
    icon: Wand2,
    title: "One composite, then split",
    description:
      "The agent paints the whole poster in one pass so artwork and lettering are designed together, then decomposes it into transparent layers.",
  },
  {
    icon: Type,
    title: "Copy stays editable",
    description:
      "Plain text never gets baked into pixels — it lands in the reserved space as real text layers you can retype, restyle, or translate.",
  },
  {
    icon: ScissorsLineDashed,
    title: "Bring any reference",
    description:
      "Drop in a finished design and it comes back as layers, ready to tweak by hand or by asking. Export as PNG, JPG, WebP, or layered PSD.",
  },
];

export function LandingDesign({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <div data-reveal className="mx-auto max-w-2xl text-center">
        <p className="inline-flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent text-accent-foreground">
            <Layers className="size-3.5" />
          </span>
          Layer Design
        </p>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          Posters that stay editable
        </h2>
        <p className="mt-3 text-pretty text-muted-foreground">
          Describe a poster or drop in a reference. The agent designs it on a
          layered artboard you can keep editing — not a flat image you have to
          regenerate.
        </p>
      </div>

      <div
        data-reveal
        className="mt-12 overflow-hidden rounded-xl border border-border bg-card md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
      >
        {/* 左：图层清单示意（与编辑器左栏同构：类型图标 + 名称 + 细节） */}
        <div className="border-b border-border bg-muted/40 p-6 sm:p-8 md:border-r md:border-b-0">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Layers · top to bottom
          </p>
          <ol className="mt-4 space-y-1.5">
            {layers.map(({ kind, name, detail }) => {
              const Icon = kind === "text" ? Type : ImageIcon;
              return (
                <li
                  key={name}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="shrink-0 text-sm font-medium">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{detail}</span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* 右：要点 + 入口 */}
        <div className="flex flex-col justify-between gap-8 p-6 sm:p-8">
          <ul className="space-y-6">
            {points.map(({ icon: Icon, title, description }) => (
              <li key={title} className="flex gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium">{title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href={isLoggedIn ? "/design" : "/login?next=/design"} />}
            >
              {isLoggedIn ? "Open Layer Design" : "Sign in to try it"}
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
