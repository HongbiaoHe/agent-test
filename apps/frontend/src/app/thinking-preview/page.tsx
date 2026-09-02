"use client";

import { Button } from "@/components/ui/button";

import type { ChatItem } from "../canvas/_lib/chat";

import {
  CanvasThinkingIndicator,
  ThinkingGrid,
  type ThinkingAnimation,
} from "../canvas/_components/thinking-indicator";
import {
  PHASE_UI,
  agentPhase,
  type AgentPhase,
} from "../canvas/_lib/thinking-phase";

/** 一行展示：左边是实例，右边贴出对应的 props。 */
function Row({
  code,
  note,
  children,
}: {
  code: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-64 flex-1">{children}</div>
      <div className="flex flex-col items-end gap-0.5">
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {code}
        </code>
        {note && (
          <span className="text-[11px] text-muted-foreground">{note}</span>
        )}
      </div>
    </div>
  );
}

/**
 * 动画方式专用的一行，按「规格表」排：左边定宽样本井，右边标题 + 规格表。
 *
 * 样本只放方阵不放文案——这一节的变量是 9 格编排，轮换文案在这里是噪音，
 * 而且 .canvas-thinking 的字号是 0.58×size，size=32 时它有 18.6px，比页面 h2 还大，
 * 会盖过真正的主角（animation 名）。井定宽也让四张卡不受文案换行影响、高度齐平。
 */
function AnimationRow({
  code,
  tag,
  motion,
  scene,
  usedBy,
  children,
}: {
  code: string;
  tag: string;
  motion: string;
  scene: string;
  usedBy: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 rounded-lg border border-border bg-card p-4">
      {/* 样本井：凹陷底色把「组件输出」和卡片正文分开 */}
      <div className="grid size-[76px] shrink-0 place-items-center rounded-md border border-border bg-muted/50">
        {children}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
          <code className="truncate font-mono text-[13px] font-medium text-foreground">
            {code}
          </code>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {tag}
          </span>
        </div>

        <dl className="grid grid-cols-[2.75rem_1fr] gap-x-2.5 pt-2 text-xs leading-5">
          <dt className="text-muted-foreground">状态</dt>
          <dd className="text-foreground">{scene}</dd>
          <dt className="text-muted-foreground">节律</dt>
          <dd className="text-foreground">{motion}</dd>
          <dt className="text-muted-foreground">取用点</dt>
          <dd className="font-mono text-[11px] text-muted-foreground">
            {usedBy}
          </dd>
        </dl>
      </div>
    </div>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** agentPhase 的输入组合，直接喂真函数，页面上打印判定结果。 */
const PHASE_CASES: { label: string; items: ChatItem[]; busy: boolean }[] = [
  { label: "busy=false", items: [], busy: false },
  { label: "空流 + busy", items: [], busy: true },
  {
    label: "末项 user",
    items: [{ id: "1", kind: "user", text: "hi" }],
    busy: true,
  },
  {
    label: "reasoning streaming",
    items: [{ id: "1", kind: "reasoning", text: "…", streaming: true }],
    busy: true,
  },
  {
    label: "reasoning 已收口",
    items: [{ id: "1", kind: "reasoning", text: "…", streaming: false }],
    busy: true,
  },
  {
    label: "tool 运行中",
    items: [{ id: "1", kind: "tool", name: "add_node", done: false }],
    busy: true,
  },
  {
    label: "tool 已完成",
    items: [{ id: "1", kind: "tool", name: "add_node", done: true }],
    busy: true,
  },
  {
    label: "assistant streaming",
    items: [{ id: "1", kind: "assistant", text: "…", streaming: true }],
    busy: true,
  },
  {
    label: "assistant 已收口",
    items: [{ id: "1", kind: "assistant", text: "…", streaming: false }],
    busy: true,
  },
  {
    label: "plan",
    items: [
      {
        id: "1",
        kind: "plan",
        todos: [{ content: "step", status: "in_progress" }],
      },
    ],
    busy: true,
  },
  {
    label: "error",
    items: [{ id: "1", kind: "error", message: "boom" }],
    busy: true,
  },
];

/**
 * 四种编排各自的节律、对应的状态、以及代码里谁在用。
 * 顺序按「忙 → 闲」排：前三种是 agent 执行期间的工作态，standby 是空闲常驻态。
 */
const ANIMATIONS: {
  value: ThinkingAnimation;
  /** 忙 / 闲的分组标签，顺带标出组件默认值 */
  tag: string;
  /** 什么状态下该用它 */
  scene: string;
  /** 九格怎么动 */
  motion: string;
  /** 代码里的实际取用点 */
  usedBy: string;
}[] = [
  {
    value: "pulse",
    tag: "执行态 · 默认",
    scene: "thinking —— 推理文本正在流式产出，agent 真的在「想」",
    motion: "9 格错峰呼吸，各格周期互不相同",
    usedBy: "PHASE_UI.thinking",
  },
  {
    value: "wave",
    tag: "执行态",
    scene:
      "working —— 工具没回、正文在产出、计划在执行，整段执行都归这一档",
    motion: "沿主对角线推进的斜向波，全格同周期、delay 按 row+col 递增",
    usedBy: "PHASE_UI.working",
  },
  {
    value: "orbit",
    tag: "执行态",
    scene: "loading —— 请求刚发出，或推理 / 工具刚收口而下一步未明",
    motion: "外圈 8 格顺时针依次点亮，中心格常亮当轴",
    usedBy: "PHASE_UI.loading",
  },
  {
    value: "standby",
    tag: "空闲态",
    scene:
      "agent 空闲 —— 活着但没在干活。不属于 AgentPhase，是 agentUi 为空时的兜底；可长期常驻，故单独尊重 prefers-reduced-motion",
    motion: "4.5s 一口气的缓慢呼吸，自中心向外漫开，逐格亮度递减",
    usedBy: "canvas-shell.tsx:160",
  },
];

export default function Page() {
  return (
    <div className="min-h-screen bg-background px-8 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">
              CanvasThinkingIndicator
            </h1>
            <p className="text-xs text-muted-foreground">
              画布 agent 思考等待态。尺寸 / 颜色 / 动画方式均可通过 props 控制。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => document.documentElement.classList.toggle("dark")}
          >
            切换亮 / 暗
          </Button>
        </header>

        <Section
          title="尺寸"
          desc="size 是整体边长（px）。方阵、间距、字号、光晕、圆点全部按它等比缩放。"
        >
          {[16, 18, 24, 40, 64].map((size) => (
            <Row
              key={size}
              code={`size={${size}}`}
              note={
                size === 24
                  ? "组件默认值"
                  : size === 18
                    ? "聊天流当前用的值"
                    : undefined
              }
            >
              <CanvasThinkingIndicator size={size} />
            </Row>
          ))}
        </Section>

        <Section
          title="动画方式"
          desc="animation 控制 9 格的编排。样本只放方阵——这一节的变量是编排本身，轮换文案在这里只会抢戏。"
        >
          {ANIMATIONS.map(({ value, tag, motion, scene, usedBy }) => (
            <AnimationRow
              key={value}
              code={`animation="${value}"`}
              tag={tag}
              motion={motion}
              scene={scene}
              usedBy={usedBy}
            >
              <ThinkingGrid animation={value} size={44} />
            </AnimationRow>
          ))}
        </Section>

        <Section
          title="颜色"
          desc="color 接任意 CSS 颜色值；光晕从它派生，所以只需给这一个。不传则跟随主题（亮暗各一套鲜亮金橙）。"
        >
          <Row code="（不传）" note="跟随主题，切到暗色看差异">
            <CanvasThinkingIndicator size={32} />
          </Row>
          {[
            ["oklch(0.62 0.19 250)", "蓝"],
            ["oklch(0.68 0.17 150)", "绿"],
            ["oklch(0.63 0.22 12)", "玫红"],
          ].map(([color, label]) => (
            <Row key={color} code={`color="${color}"`} note={label}>
              <CanvasThinkingIndicator size={32} color={color} />
            </Row>
          ))}
        </Section>

        <Section
          title="按 agent 阶段自动切换"
          desc="canvas 聊天流里不写死形态，而是从消息流末尾推断 agent 在干什么，动画与文案一起换。"
        >
          {(Object.keys(PHASE_UI) as AgentPhase[]).map((phase) => (
            <Row
              key={phase}
              code={`phase="${phase}" → ${PHASE_UI[phase].animation}`}
              note={PHASE_UI[phase].hint}
            >
              <CanvasThinkingIndicator
                size={18}
                animation={PHASE_UI[phase].animation}
                phrases={PHASE_UI[phase].phrases}
              />
            </Row>
          ))}
          <div className="rounded-lg border border-border bg-card px-4 py-3">
            <p className="mb-2 text-xs font-medium text-foreground">
              agentPhase() 判定（跑的是聊天流里同一个函数）
            </p>
            <table className="w-full text-left font-mono text-[11px] text-muted-foreground">
              <tbody>
                {PHASE_CASES.map(({ label, items, busy }) => (
                  <tr key={label} className="border-t border-border">
                    <td className="py-1 pr-3">{label}</td>
                    <td className="py-1 text-foreground">
                      {String(agentPhase(items, busy))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="实际场景"
          desc="固定在输入框正上方，不随消息流滚动——agent 执行期间始终看得见。文案每 2.6s 上滚换一条。"
        >
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex flex-col gap-2.5 p-4">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  帮我搭一个抓取 → 摘要 → 配图的流程
                </div>
              </div>
              <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                Add node · Connect nodes · 4 steps
              </div>
            </div>
            {/* 状态条：不描边、不给底色，是消息区的延续 */}
            <div className="py-2 pr-4 pl-2">
              <CanvasThinkingIndicator
                size={18}
                animation={PHASE_UI.working.animation}
                phrases={PHASE_UI.working.phrases}
              />
            </div>
            {/* 输入框 */}
            <div className="border-t border-border p-3">
              <div className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-muted-foreground">
                Agent running…
              </div>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
