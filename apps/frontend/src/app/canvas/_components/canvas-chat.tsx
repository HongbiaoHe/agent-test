"use client";

import {
  AlertTriangle,
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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { ChatItem, ChatState } from "../_lib/chat";
import { DEFAULT_CANVAS_MODEL } from "../_lib/models";
import { Markdown } from "./markdown";
import { CanvasModelSwitcher } from "./model-switcher";

const TOOL_LABEL: Record<string, string> = {
  add_node: "添加节点",
  update_node: "更新节点",
  connect_nodes: "连接节点",
  delete_node: "删除节点",
  generate_media_node: "触发生成",
  get_canvas: "读取画布",
  ask_user: "向你提问",
  write_todos: "规划任务",
};

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function preview(v: unknown, n = 48): string {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 由工具名 + 参数推出「做了啥」的一句人话明细。 */
function toolDetail(item: ToolItem): string {
  const a = item.args ?? {};
  switch (item.name) {
    case "add_node": {
      const parts = [a.type, a.label, a.prompt ?? a.text]
        .filter(Boolean)
        .map((x) => preview(x, 32));
      return parts.join(" · ");
    }
    case "update_node":
      return preview(a.prompt ?? a.text ?? a.label ?? a.nodeId);
    case "connect_nodes":
      return "新增一条连线";
    case "delete_node":
      return "移除一个节点";
    case "generate_media_node":
      return item.done ? "已发起生成" : "触发生成…";
    case "get_canvas":
      return "查看当前节点与连线";
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
          {running ? "执行中…" : `${tools.length} 步`}
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
        <span className="flex-1">任务计划</span>
        {paused && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
            已暂停
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

  // 确认型（clear_canvas 等破坏性操作）：只给「确认 / 取消」两个按钮，不填答案
  if (ask.tool === "clear_canvas") {
    return (
      <div className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" />
          Agent 请求确认
        </div>
        <p className="text-sm text-muted-foreground">
          即将清空整块画布（删除全部节点与连线），此操作不可撤销。确认执行？
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="destructive"
            onClick={() => onResolve(true)}
          >
            确认清空
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve(false)}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Sparkles className="size-4 text-primary" />
        Agent 提问
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
          placeholder="输入你的回答…"
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
          回答
        </Button>
      </div>
    </div>
  );
}

export function CanvasChat({
  chat,
  tokens,
  busy,
  sessionModel,
  onSend,
  onStop,
  onAnswer,
  onResolve,
}: {
  chat: ChatState;
  tokens: number;
  busy: boolean;
  /** 会话当前模型（初始化切换器）；null 时用默认。 */
  sessionModel?: string | null;
  onSend: (text: string, model?: string) => void;
  onStop: () => void;
  onAnswer: (msg: string) => void;
  onResolve: (approve: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(sessionModel ?? DEFAULT_CANVAS_MODEL);
  // 快照异步加载 / 切换会话后，把切换器同步到该会话实际模型（render 期调整 state，
  // 规避 Next16 的 effect-setState 限制）。用户本地改选后 sessionModel 不变，不会被覆盖。
  const [seenSessionModel, setSeenSessionModel] = useState(sessionModel ?? null);
  if (sessionModel && sessionModel !== seenSessionModel) {
    setSeenSessionModel(sessionModel);
    setModel(sessionModel);
  }
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.items, chat.ask]);

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t, model);
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
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">画布 Agent</span>
        <Badge variant="secondary" title="本次运行累计 token">
          {tokens.toLocaleString()} tokens
        </Badge>
      </div>

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
              busy ? "Agent 运行中…" : "描述你想要的工作流，Agent 会自动搭建"
            }
            disabled={busy}
            rows={1}
            className="max-h-40 min-h-0 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <CanvasModelSwitcher
              value={model}
              onChange={setModel}
              disabled={busy}
            />
            {busy ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={onStop}
                className="h-8 gap-1.5 rounded-lg px-2.5 text-xs"
              >
                <Square className="size-3.5" />
                停止
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={submit}
                disabled={!text.trim()}
                title="发送 (Enter)"
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
