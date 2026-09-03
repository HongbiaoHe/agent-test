import {
  ArrowLeft,
  ArrowRight,
  Film,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Type,
  Upload,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { auth } from "@/auth";
import { ThemeToggle } from "@/app/_components/theme-toggle";
import { Button } from "@/components/ui/button";
import { GlowBorder } from "@/components/ui/glow-border";
import type { CanvasNodeType } from "@/lib/api";

import {
  CanvasThinkingIndicator,
  ThinkingGrid,
} from "./_components/thinking-indicator";
import { AGENT_FACES } from "./_intro/agent-faces";
import { IntroHero } from "./_intro/intro-hero";
import { CANVAS_NODE_IO, NODE_TYPE_LABEL } from "./_lib/node-io";
import { PHASE_UI } from "./_lib/thinking-phase";

export const metadata: Metadata = {
  title: "Canvas — nine squares",
  description:
    "What the canvas is: text, image and video nodes on one board, wired up by an agent whose nine-square face tells you what it is doing.",
};

/**
 * 节点契约的展示顺序 + 每类节点的图标与一句说明。
 *
 * 端口本身**不**在这里写：inputs / outputs 直接读 CANVAS_NODE_IO（node-io.ts，
 * 它又镜像后端 canvas.types 的权威定义）。介绍页最容易过期的就是这种清单，
 * 所以只留「说法」在本文件，「事实」一律从源头取。
 */
const NODE_NOTES: {
  type: CanvasNodeType;
  Icon: typeof Type;
  note: string;
}[] = [
  {
    type: "text",
    Icon: Type,
    note: "The prompt lives here, and nowhere else.",
  },
  {
    type: "image_upload",
    Icon: Upload,
    note: "A picture you bring in yourself.",
  },
  {
    type: "image_gen",
    Icon: ImageIcon,
    note: "Draws a frame from the text and images wired into it.",
  },
  {
    type: "video_gen",
    Icon: Film,
    note: "Moves it. Takes the same upstream text and images.",
  },
  {
    type: "video_concat",
    Icon: Layers,
    note: "Joins upstream clips in edge order — local ffmpeg, no model.",
  },
];

/** 生图 / 生视频各自值得单独说的两点（都能在代码里指到出处，见注释）。 */
const CAPABILITIES: { title: string; points: string[] }[] = [
  {
    title: "Images",
    points: [
      // node-io.ts:19 + resolvePrompt()：生成节点没有自己的提示词字段
      "A generation node owns no prompt field. It reads the prompt off the text nodes wired into it, so editing one text node re-aims everything downstream.",
      // use-aigc-models.ts + node-model-controls.tsx 的 PARAM_LABEL
      "Model and tier sit on the node — ratio, quality — and the list comes from the server's live catalogue rather than a hardcoded menu.",
    ],
  },
  {
    title: "Video",
    points: [
      // aigc.catalog.ts videoRefRole()：默认 reference，i2v-only 的模型退回 first_frame
      "Connect an image and it goes in as a reference, so the subject stays consistent. Models that only do image-to-video take it as the first frame instead.",
      // PARAM_LABEL 的 duration / with_audio + CANVAS_NODE_IO.video_concat
      "Duration and audio are tiers on the node too, and several finished clips can be merged into one shot.",
    ],
  },
];

/** 一句人话 + 出处在代码里的位置（注释里标，不印在页面上）。 */
const BUDDY_POINTS: string[] = [
  // canvas-shell.tsx:160-176：右侧竖轨上的常驻入口，图标就是方阵本身
  "It lives in the rail of every board as a breathing grid, not a static icon. Glance at it and you know whether anything is happening.",
  // thinking-indicator.tsx 的 ROTATE_MS = 2600
  "It says what it is doing in plain words, a fresh line every 2.6 seconds — no log to open, no spinner to interpret.",
  // approval-switcher.tsx：review / auto 两档
  "It asks first. Clearing the board or spending a generation waits for your yes, until you hand it full autopilot.",
];

/** 区块外壳：标题 + 副题 + 内容，间距与落地页保持同一套节奏。 */
function Section({
  id,
  title,
  lede,
  children,
  className,
}: {
  id?: string;
  title: string;
  lede: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={className}>
      <div className="mx-auto w-full max-w-5xl px-6 py-20 md:px-8 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h2>
          <p className="mt-3 text-pretty text-muted-foreground">{lede}</p>
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

/**
 * 隐喻区与收口处方阵的一道 2px 缝。
 *
 * 产品里的方阵是 18–24px、九格靠明暗差就分得清，所以本身不带 gap。放大到 40px 以上后，
 * 同亮度的相邻格会连成一整块——而这一页反复在说「九格」，数不出来就说不通。
 * 只加在讲隐喻的地方；下面 States 区不加，那里要的就是它在产品里的原样。
 */
const SEAM = "gap-[2px]";

/** 端口清单：["text"] → "text"，空数组读作 none（源节点没有入端口）。 */
function ports(list: readonly string[]): string {
  return list.length === 0 ? "none" : list.join(" · ");
}

export default async function CanvasIntroPage() {
  // 这一页公开（middleware 只放行精确 /canvas），所以两种人都会来：
  // 已登录的人 CTA 直达自己的画布，没登录的人先去登录——画布列表本身仍在墙后。
  const session = await auth();
  const isLoggedIn = Boolean(session?.user);

  return (
    <main className="min-h-screen bg-background">
      {/* 顶栏：左边回落地页，右边是去画布列表的快车道 + 主题切换。
          介绍页也要能在暗色下自证——方阵的亮暗两套配色正是它要展示的东西之一。
          列表入口在顶栏也留一个：首屏 CTA 是给第一次来的人看的，
          回头客只想直接进自己的画布，不该逼他们先读完一屏。 */}
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 pt-6 md:px-8">
        <Link
          href="/"
          className="group/back -ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
        >
          <ArrowLeft className="size-3.5 transition-transform duration-200 group-hover/back:-translate-x-0.5 motion-reduce:transition-none" />
          AgentSpark
        </Link>
        <div className="flex items-center gap-2">
          {isLoggedIn ? (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/canvas-list" />}
            >
              <LayoutGrid className="size-4" />
              Canvases
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/login?next=/canvas-list" />}
            >
              Sign in
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>

      <IntroHero isLoggedIn={isLoggedIn} />

      {/* 隐喻区：像素 → 一帧 → 一段。三张卡的视觉全部由同一种方格搭出来，
          说的就是「这三件事是同一种东西的三个尺度」 */}
      <Section
        id="pixels"
        className="border-t border-border bg-muted/30"
        title="One square, and then some"
        lede="The metaphor is not decoration — it is the product's own unit of work, at three scales."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="grid h-24 place-items-center">
              {/* 一格：单独一个方块，不动。像素本身没有状态 */}
              <span
                aria-hidden
                className="size-9 bg-[var(--thinking-cell)]"
              />
            </div>
            <h3 className="mt-4 font-medium text-foreground">
              One square is a pixel
            </h3>
            <p className="mt-1.5 text-sm text-muted-foreground">
              The smallest thing the canvas deals in. On its own it just sits
              there, lit.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <div className="grid h-24 place-items-center">
              <ThinkingGrid size={56} animation="standby" className={SEAM} />
            </div>
            <h3 className="mt-4 font-medium text-foreground">
              Nine squares are a frame
            </h3>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Step back and the grid is a picture — which is exactly what an
              image node hands to whatever is wired downstream.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex h-24 items-center justify-center gap-3">
              {/* 三帧并排走同一道斜波：读起来是「同一张图在往前动」 */}
              {[0, 1, 2].map((i) => (
                <ThinkingGrid key={i} size={40} animation="wave" className={SEAM} />
              ))}
            </div>
            <h3 className="mt-4 font-medium text-foreground">
              Frames in a row are a shot
            </h3>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Line the frames up and they move. That is a video node: the same
              pixels, now with time running through them.
            </p>
          </div>
        </div>
      </Section>

      {/* 能力区：先摆真实的节点契约表，再各说生图 / 生视频的两个点 */}
      <Section
        id="make"
        className="border-t border-border"
        title="What it makes"
        lede="Five node types with typed ports. Text feeds a generator, a generator feeds the next one, and wiring that cannot work is refused before it reaches the queue."
      >
        <ol className="overflow-hidden rounded-xl border border-border bg-card">
          {NODE_NOTES.map(({ type, Icon, note }, i) => (
            <li
              key={type}
              className={
                i > 0 ? "border-t border-border/70" : undefined
              }
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-4.5" />
                </span>
                <div className="min-w-56 flex-1">
                  <div className="font-medium text-foreground">
                    {NODE_TYPE_LABEL[type]}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{note}</p>
                </div>
                {/* 端口读自 CANVAS_NODE_IO，改后端契约这一行自己就跟着变。
                    两列都定宽右对齐：入端口最长的一行是 text · image · video，
                    不定宽的话每行的 in 起点各不相同，五行读下来是锯齿状的 */}
                <dl className="ml-auto flex shrink-0 gap-6 font-mono text-[11px] text-muted-foreground">
                  <div className="w-36 text-right">
                    <dt className="text-muted-foreground/70">in</dt>
                    <dd className="mt-0.5 text-foreground">
                      {ports(CANVAS_NODE_IO[type].inputs)}
                    </dd>
                  </div>
                  <div className="w-14 text-right">
                    <dt className="text-muted-foreground/70">out</dt>
                    <dd className="mt-0.5 text-foreground">
                      {ports(CANVAS_NODE_IO[type].outputs)}
                    </dd>
                  </div>
                </dl>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {CAPABILITIES.map(({ title, points }) => (
            <div
              key={title}
              className="rounded-xl border border-border bg-card p-6"
            >
              <h3 className="font-medium text-foreground">{title}</h3>
              <ul className="mt-3 space-y-3">
                {points.map((p) => (
                  <li
                    key={p}
                    className="flex gap-2.5 text-sm text-muted-foreground"
                  >
                    <span
                      aria-hidden
                      className="mt-1.5 size-1.5 shrink-0 bg-[var(--thinking-cell)]"
                    />
                    <span className="text-pretty">{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      {/* 状态区：四种编排并排对照，每张卡里是真的组件在跑 */}
      <Section
        id="states"
        className="border-t border-border bg-muted/30"
        title="Four faces, one shape"
        lede="Nothing about the grid changes except its rhythm — and the rhythm is the status. You never have to open a log to find out whether it is thinking or doing."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {AGENT_FACES.map(({ key, animation, name, meaning, sample }) => (
            <div
              key={key}
              className="flex gap-4 rounded-xl border border-border bg-card p-5"
            >
              {/* 样本井：凹陷底色把「组件输出」和卡片正文分开（同 thinking-preview） */}
              <div className="grid size-20 shrink-0 place-items-center rounded-lg border border-border bg-muted/50">
                <ThinkingGrid size={48} animation={animation} />
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <h3 className="font-medium text-foreground">{name}</h3>
                  <code className="font-mono text-[11px] text-muted-foreground">
                    {animation}
                  </code>
                </div>
                <p className="mt-1.5 text-pretty text-sm text-muted-foreground">
                  {meaning}
                </p>
                <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/80">
                  “{sample}”
                </p>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Every delay, period and easing behind those four is written down on
          the{" "}
          <Link
            href="/thinking-preview"
            className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground motion-reduce:transition-none"
          >
            indicator spec page
          </Link>
          .
        </p>
      </Section>

      {/* 伙伴区：三条行为 + 真组件跑一遍「它正在干活」的样子 */}
      <Section
        id="agent"
        className="border-t border-border"
        title="Less tool, more colleague"
        lede="An agent you can read at a glance is an agent you can leave running. That is the whole reason it has a face."
      >
        <div className="grid items-start gap-8 lg:grid-cols-[1fr_20rem] lg:gap-12">
          <ul className="space-y-6">
            {BUDDY_POINTS.map((point) => (
              <li key={point} className="flex gap-4">
                <span className="mt-1 shrink-0">
                  <ThinkingGrid size={16} animation="standby" />
                </span>
                <p className="text-pretty text-muted-foreground">{point}</p>
              </li>
            ))}
          </ul>

          {/* 实物演示：和聊天流里同一个组件、同一套文案，18px 也是它在画布上的真实尺寸 */}
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-2.5 p-4">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  Storyboard this in three shots, then move the last one.
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                Add node · Connect nodes · Generate · 6 steps
              </div>
            </div>
            <div className="py-2 pl-2 pr-4">
              <CanvasThinkingIndicator
                size={18}
                animation={PHASE_UI.working.animation}
                phrases={PHASE_UI.working.phrases}
              />
            </div>
            <div className="border-t border-border p-3">
              <div className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-muted-foreground">
                Agent running…
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 收口 */}
      <section className="border-t border-border bg-muted/30">
        <div className="mx-auto w-full max-w-5xl px-6 py-20 md:px-8 md:py-24">
          <GlowBorder className="mx-auto max-w-2xl bg-card p-10 text-center sm:p-14">
            <div className="flex justify-center">
              <ThinkingGrid size={40} animation="standby" className={SEAM} />
            </div>
            <h2 className="mt-6 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Nine squares are standing by
            </h2>
            <p className="mx-auto mt-3 max-w-md text-pretty text-muted-foreground">
              Open a board, describe the shot in a sentence, and watch the cards
              fill in.
            </p>
            <div className="mt-8 flex justify-center">
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
            </div>
          </GlowBorder>
        </div>
      </section>
    </main>
  );
}
