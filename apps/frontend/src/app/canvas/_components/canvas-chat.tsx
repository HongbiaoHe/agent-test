"use client";

import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  CircleDot,
  Loader2,
  Pause,
  Send,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { ChatItem, ChatState } from "../_lib/chat";
import { PHASE_UI, agentPhase } from "../_lib/thinking-phase";
import {
  DEFAULT_CANVAS_MODEL,
  type ThinkingLevel,
  supportsThinkingLevel,
} from "../_lib/models";
import { Markdown } from "./markdown";
import { CanvasModelSwitcher } from "./model-switcher";
import { CanvasThinkingIndicator } from "./thinking-indicator";
import { CanvasThinkingSwitcher } from "./thinking-switcher";

const TOOL_LABEL: Record<string, string> = {
  add_node: "Add node",
  update_node: "Update node",
  connect_nodes: "Connect nodes",
  delete_node: "Delete node",
  generate_media_node: "Run generation",
  get_canvas: "Read canvas",
  ask_user: "Ask you",
  write_todos: "Plan tasks",
};

/** 确认型中断工具（approve/reject 二选一），与后端 interruptOn 配置对应。 */
const CONFIRM_TOOLS = new Set(["clear_canvas", "generate_media_node"]);

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 把（可能过期的）档位归一到当前模型支持的取值；不支持则回落 auto。 */
function normalizeThinking(
  model: string,
  level: string | null | undefined,
): ThinkingLevel {
  const lv = (level ?? "auto") as ThinkingLevel;
  return supportsThinkingLevel(model, lv) ? lv : "auto";
}
type ReasoningItem = Extract<ChatItem, { kind: "reasoning" }>;

function preview(v: unknown, n = 48): string {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 由工具名 + 参数推出「做了啥」的一句人话明细。 */
function toolDetail(item: ToolItem): string {
  const a = item.args ?? {};
  switch (item.name) {
    case "add_node": {
      const parts = [a.type, a.label, a.text]
        .filter(Boolean)
        .map((x) => preview(x, 32));
      return parts.join(" · ");
    }
    case "update_node":
      return preview(a.text ?? a.label ?? a.nodeId);
    case "connect_nodes":
      return "Added an edge";
    case "delete_node":
      return "Removed a node";
    case "generate_media_node":
      return item.done ? "Generation started" : "Starting generation…";
    case "get_canvas":
      return "Read nodes and edges";
    case "ask_user":
      return preview(a.question);
    default:
      return preview(item.result, 40);
  }
}

/** 单条工具行：图标（完成/进行中）+ 动作名 + 明细。 */
function ToolRow({ item }: { item: ToolItem }) {
  const detail = toolDetail(item);
  return (
    <div className="flex items-start gap-2 text-xs">
      {item.done ? (
        <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
      ) : (
        <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="min-w-0">
        <span className="font-medium text-foreground">
          {TOOL_LABEL[item.name] ?? item.name}
        </span>
        {detail && (
          <span className="ml-1.5 break-words text-muted-foreground">
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 连续工具调用聚合块：≥2 折叠成可点击展开的块（概述行列出各动作名，运行中转圈）；
 * 单个直接平铺。展开后每步显示「做了啥」。
 */
function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => !t.done);

  if (tools.length === 1) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
        <ToolRow item={tools[0]} />
      </div>
    );
  }

  const names = tools.map((t) => TOOL_LABEL[t.name] ?? t.name).join(" · ");
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={names}>
          {names}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {running ? "Running…" : `${tools.length} steps`}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border px-2.5 py-2">
          {tools.map((t) => (
            <ToolRow key={t.id} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 思考过程块：可折叠。流式期间默认展开（让用户看到 agent 正在想什么），思考结束自动收起；
 * 用户手动点过之后就以手动状态为准，不再被自动折叠打断。
 */
function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? item.streaming;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
      >
        {item.streaming ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {item.streaming ? "Thinking…" : "Thought process"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-border px-2.5 py-2">
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
            {item.text}
          </p>
        </div>
      )}
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
            {item.text}
          </div>
        </div>
      );
    case "reasoning":
      return <ReasoningBlock item={item} />;
    case "assistant":
      return (
        <div className="max-w-[90%] rounded-lg bg-muted px-3 py-2 text-foreground">
          <Markdown>{item.text}</Markdown>
          {item.streaming && (
            <span className="ml-0.5 animate-pulse text-muted-foreground">▋</span>
          )}
        </div>
      );
    case "tool":
      // 通常由 map 里的分组处理；单独出现时也套一层组壳
      return <ToolGroup tools={[item]} />;
    case "plan":
      // 计划不在流内渲染（抽到输入框上方的固定面板）
      return null;
    case "error":
      return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {item.message}
        </div>
      );
  }
}

/** 渲染消息流：连续的工具调用聚合进一个 ToolGroup，其余各自成项。 */
function renderItems(items: ChatItem[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buffer: ToolItem[] = [];
  const flush = () => {
    if (buffer.length) {
      out.push(<ToolGroup key={`tg-${buffer[0].id}`} tools={buffer} />);
      buffer = [];
    }
  };
  for (const it of items) {
    if (it.kind === "tool") {
      buffer.push(it);
      continue;
    }
    // plan 不在流里内联：抽到输入框上方的固定可折叠面板呈现（见 TaskPlanPanel）
    if (it.kind === "plan") continue;
    flush();
    out.push(<Item key={it.id} item={it} />);
  }
  flush();
  return out;
}

/** 固定在输入框上方的任务计划面板：可折叠，标题显示完成进度。 */
function TaskPlanPanel({
  todos,
  active,
}: {
  todos: { content: string; status: string }[];
  /** 是否正在运行；否则计划里未完成的步骤视为「已暂停」（用户停止或运行中断的残留）。 */
  active: boolean;
}) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const hasIncomplete = done < todos.length;
  const running = active && todos.some((t) => t.status === "in_progress");
  // 不在运行 + 还有没做完的步骤 → 计划处于暂停态
  const paused = !active && hasIncomplete;
  return (
    <div className="shrink-0 border-t border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium transition-colors hover:bg-accent"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : paused ? (
          <Pause className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1">Task plan</span>
        {paused && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            Paused
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {done}/{todos.length}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <ul className="max-h-40 space-y-1 overflow-y-auto px-4 pb-2.5 text-xs">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-muted-foreground">
              {t.status === "completed" ? (
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
              ) : t.status === "in_progress" ? (
                running ? (
                  <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
                ) : (
                  <Pause className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                )
              ) : (
                <CircleDot className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span
                className={cn(
                  t.status === "completed" && "line-through opacity-70",
                )}
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AskPanel({
  ask,
  onAnswer,
  onResolve,
}: {
  ask: NonNullable<ChatState["ask"]>;
  onAnswer: (msg: string) => void;
  onResolve: (approve: boolean) => void;
}) {
  const [text, setText] = useState("");

  // 确认型（破坏性/消耗性操作）：只给「确认 / 取消」两个按钮，不填答案。
  // clear_canvas 走 destructive 红色语义；generate_media_node 是普通消耗确认走 primary。
  if (CONFIRM_TOOLS.has(ask.tool)) {
    const destructive = ask.tool === "clear_canvas";
    const text =
      ask.tool === "clear_canvas"
        ? "This clears the whole canvas (every node and edge). It cannot be undone. Proceed?"
        : ask.question;
    return (
      <div
        className={cn(
          "space-y-2.5 rounded-lg border p-3",
          destructive
            ? "border-destructive/40 bg-destructive/5"
            : "border-primary/40 bg-primary/5",
        )}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle
            className={cn(
              "size-4",
              destructive ? "text-destructive" : "text-primary",
            )}
          />
          Agent needs approval
        </div>
        <p className="text-sm text-muted-foreground">{text}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={() => onResolve(true)}
          >
            {destructive ? "Clear canvas" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Sparkles className="size-4 text-primary" />
        Agent asks
      </div>
      <p className="text-sm text-muted-foreground">{ask.question}</p>
      {ask.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ask.options.map((o) => (
            <Button key={o} size="sm" variant="outline" onClick={() => onAnswer(o)}>
              {o}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your answer…"
          className="min-h-9 resize-none"
        />
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() => {
            onAnswer(text.trim());
            setText("");
          }}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}

export function CanvasChat({
  chat,
  busy,
  sessionModel,
  sessionThinkingLevel,
  onSend,
  onStop,
  onAnswer,
  onResolve,
}: {
  chat: ChatState;
  busy: boolean;
  /** 会话当前模型（初始化切换器）；null 时用默认。 */
  sessionModel?: string | null;
  /** 会话当前思考深度档位（初始化切换器）；null = 跟随模型默认（auto）。 */
  sessionThinkingLevel?: string | null;
  onSend: (text: string, model?: string, thinkingLevel?: ThinkingLevel) => void;
  onStop: () => void;
  onAnswer: (msg: string) => void;
  onResolve: (approve: boolean) => void;
}) {
  const [text, setText] = useState("");
  // agent 当前阶段：决定流末尾指示器显不显示、以哪种形态显示
  const phase = agentPhase(chat.items, busy);
  const [model, setModel] = useState(sessionModel ?? DEFAULT_CANVAS_MODEL);
  // 快照异步加载 / 切换会话后，把切换器同步到该会话实际模型（render 期调整 state，
  // 规避 Next16 的 effect-setState 限制）。用户本地改选后 sessionModel 不变，不会被覆盖。
  const [seenSessionModel, setSeenSessionModel] = useState(sessionModel ?? null);
  if (sessionModel && sessionModel !== seenSessionModel) {
    setSeenSessionModel(sessionModel);
    setModel(sessionModel);
  }
  // 思考深度：同上的同步套路（render 期调整 state，不用 effect）。
  // 存库的档位可能已不被当前模型支持（换过模型，或能力表更新——例如 gemini-3.6-flash 其实
  // 不接受关闭思考），一律先归一，避免切换器显示一个下拉里根本没有的档位。
  const [thinking, setThinking] = useState<ThinkingLevel>(() =>
    normalizeThinking(sessionModel ?? DEFAULT_CANVAS_MODEL, sessionThinkingLevel),
  );
  const [seenThinking, setSeenThinking] = useState(sessionThinkingLevel ?? null);
  if (sessionThinkingLevel && sessionThinkingLevel !== seenThinking) {
    setSeenThinking(sessionThinkingLevel);
    setThinking(normalizeThinking(model, sessionThinkingLevel));
  }

  /** 换模型时把不适用的档位收回 auto——两家能力不对等，留着会变成点了没反应的假选项。 */
  function changeModel(next: string) {
    setModel(next);
    if (!supportsThinkingLevel(next, thinking)) setThinking("auto");
  }
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.items, chat.ask]);

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t, model, thinking);
    setText("");
  }

  const planItem = chat.items.find((it) => it.kind === "plan");
  const planTodos = planItem?.kind === "plan" ? planItem.todos : null;
  // 计划全部完成即隐藏面板（任务做完了不再占位；下一条命令产生新 plan_update 会覆盖 → 面板重现）
  const planAllDone =
    !!planTodos &&
    planTodos.length > 0 &&
    planTodos.every((t) => t.status === "completed");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* min-h-0 关键：让 ScrollArea 在 flex 列里可收缩并内部滚动，而不是撑高整列溢出屏幕 */}
      <ScrollArea className="min-h-0 flex-1 px-4">
        <div className="flex flex-col gap-2.5 py-4">
          {renderItems(chat.items)}
          {chat.ask && (
            <AskPanel
              ask={chat.ask}
              onAnswer={onAnswer}
              onResolve={onResolve}
            />
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {planTodos && planTodos.length > 0 && !planAllDone && (
        <TaskPlanPanel todos={planTodos} active={busy} />
      )}

      {/* agent 状态条：固定在输入框正上方，不随消息流滚走——执行期间要始终看得见。
          不给底色也不描边——它是消息区的延续，不是独立面板，多一道分隔线只会把聊天区切碎。
          刻意不带 key={phase}：执行中阶段切得很勤，重挂载会让文案每次都从头淡入，
          反而比阶段本身更抢眼。保持挂载，只换 animation / phrases。
          左内边距比常规 px-4 少一点，是因为指示器自带光晕呼吸位，补齐后正好对上消息区。 */}
      {!chat.ask && phase && (
        <div className="shrink-0 py-2 pr-4 pl-2">
          <CanvasThinkingIndicator
            size={18}
            animation={PHASE_UI[phase].animation}
            phrases={PHASE_UI[phase].phrases}
          />
        </div>
      )}

      <div className="shrink-0 border-t border-border p-3">
        {/* 一体化 composer：容器承接焦点态（primary 描边 + 焦点环 + 轻抬升），
            textarea 去边框内嵌、随输入自动增高（field-sizing-content），发送键内嵌右下 */}
        <div
          className={cn(
            "group rounded-xl border border-input bg-background px-3 py-2.5 transition-all duration-200",
            "focus-within:border-primary/50 focus-within:shadow-sm focus-within:ring-3 focus-within:ring-ring/40",
            busy && "opacity-80",
          )}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              busy ? "Agent running…" : "Describe the workflow, the agent builds it"
            }
            disabled={busy}
            rows={1}
            className="max-h-40 min-h-0 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <CanvasModelSwitcher
                value={model}
                onChange={changeModel}
                disabled={busy}
              />
              <CanvasThinkingSwitcher
                model={model}
                value={thinking}
                onChange={setThinking}
                disabled={busy}
              />
            </div>
            {busy ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={onStop}
                className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
              >
                <Square className="size-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={submit}
                disabled={!text.trim()}
                title="Send (Enter)"
                className="size-8 rounded-lg transition-transform active:translate-y-px disabled:opacity-40"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
