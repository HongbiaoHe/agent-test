"use client";

import { Button } from "@/components/ui/button";

import type { ChatItem } from "../canvas/_lib/chat";

import {
  CanvasThinkingIndicator,
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

const ANIMATIONS: { value: ThinkingAnimation; note: string }[] = [
  { value: "pulse", note: "9 格错峰呼吸，周期互不相同（默认）" },
  { value: "wave", note: "沿主对角线推进的斜向波" },
  { value: "orbit", note: "外圈顺时针依次点亮，中心常亮当轴" },
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
          desc="animation 控制 9 格的编排。wave / orbit 用更短促的脉冲，才读得出方向。"
        >
          {ANIMATIONS.map(({ value, note }) => (
            <Row key={value} code={`animation="${value}"`} note={note}>
              <CanvasThinkingIndicator animation={value} size={32} />
            </Row>
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
