"use client";

import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  CircleDot,
  FlaskConical,
  Loader2,
  MessagesSquare,
  Paperclip,
  Pause,
  Send,
  Sparkles,
  Square,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ThinkingSwitcher } from "@/components/agent/thinking-switcher";
import { ATTACHMENT_ACCEPT } from "@/components/attachments/attachments";
import { ComposerAttachments } from "@/components/attachments/composer-attachments";
import { MessageAttachments } from "@/components/attachments/message-attachments";
import { useAttachments } from "@/components/attachments/use-attachments";
import { ErrorNotice } from "@/components/chat/error-notice";
import { JumpToLatest } from "@/components/chat/jump-to-latest";
import { useChatScroll } from "@/components/chat/use-chat-scroll";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  type CanvasApprovalMode,
  type MessageAttachment,
  uploadCanvasAttachment,
} from "@/lib/api";

import type { ChatItem, ChatState } from "../_lib/chat";
import { PHASE_UI, agentPhase } from "../_lib/thinking-phase";
import {
  normalizeCanvasModel,
  type ThinkingLevel,
  supportsThinkingLevel,
} from "../_lib/models";
import { CanvasApprovalSwitcher } from "./approval-switcher";
import { Markdown } from "./markdown";
import { CanvasModelSwitcher } from "./model-switcher";
import { CanvasThinkingIndicator } from "./thinking-indicator";
import {
  CANVAS_SKILLS_KEY,
  useCanvasSkills,
} from "../_skills/use-canvas-skills";
import { SkillCommandMenu } from "../_skills/skill-command-menu";
import { SkillPicker } from "../_skills/skill-picker";
import { SkillsDialog } from "../_skills/skills-dialog";
import {
  leadingSkill,
  slashQuery,
  withSkill,
  withoutSkill,
} from "../_skills/slash";

const TOOL_LABEL: Record<string, string> = {
  add_node: "Add node",
  update_node: "Update node",
  connect_nodes: "Connect nodes",
  delete_node: "Delete node",
  generate_media_node: "Run generation",
  get_canvas: "Read canvas",
  ask_user: "Ask you",
  write_todos: "Plan tasks",
  save_skill: "Save skill",
  read_file: "Read file",
};

/** 确认型中断工具（approve/reject 二选一），与后端 interruptOn 配置对应。 */
const CONFIRM_TOOLS = new Set([
  "clear_canvas",
  "generate_media_node",
  "save_skill",
]);

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
    case "save_skill":
      return typeof a.name === "string" ? `/${a.name}` : "";
    case "read_file":
      // 读技能说明时显示读的是哪个技能，比整条路径好认
      return typeof a.file_path === "string"
        ? a.file_path.replace(/^\/skills\/([^/]+)\/SKILL\.md$/, "skill · $1")
        : "";
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

function Item({
  item,
  invokedSkill,
}: {
  item: ChatItem;
  /** 这条用户消息确实调起了的技能（后端紧跟着注入了调用）；没有则 undefined */
  invokedSkill?: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        // data-chat-anchor：发送后 useChatScroll 靠它把这条消息顶到视口顶部（取最后一个）
        <div data-chat-anchor className="flex flex-col items-end gap-1.5">
          <MessageAttachments attachments={item.attachments} />
          {/* 只发了附件的消息没有正文，不画空气泡 */}
          {item.text && (
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              <UserText text={item.text} invokedSkill={invokedSkill} />
            </div>
          )}
        </div>
      );
    case "skill":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Wand2 className="size-3.5 shrink-0 text-primary" aria-hidden />
          Using skill
          <span className="font-medium text-foreground">{item.name}</span>
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
      return <ErrorNotice message={item.message} />;
  }
}

/**
 * 用户消息：开头的 /技能名 渲染成一枚标签，看得出这条消息是交给哪个技能的。
 * 只认真的调起了技能的那条——随手打的 `/2x 再快点` 不该被画成技能标签。
 */
function UserText({
  text,
  invokedSkill,
}: {
  text: string;
  invokedSkill?: string;
}) {
  const cmd = leadingSkill(text);
  if (!cmd || cmd.name !== invokedSkill) return text;
  return (
    <>
      <span className="mr-1 rounded-sm bg-primary-foreground/15 px-1 py-px font-mono text-[12px]">
        /{cmd.name}
      </span>
      {cmd.rest}
    </>
  );
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
  items.forEach((it, i) => {
    if (it.kind === "tool") {
      buffer.push(it);
      return;
    }
    // plan 不在流里内联：抽到输入框上方的固定可折叠面板呈现（见 TaskPlanPanel）
    if (it.kind === "plan") return;
    flush();
    // 后端调起技能时紧跟在用户消息后面注入一条 skill 项——这是「真的调用了」的唯一凭据
    const next = items[i + 1];
    const invokedSkill =
      it.kind === "user" && next?.kind === "skill" ? next.name : undefined;
    out.push(<Item key={it.id} item={it} invokedSkill={invokedSkill} />);
  });
  flush();
  return out;
}

/**
 * 贴在输入框正上方的任务计划面板：可折叠，标题显示完成进度，可手动作废。
 * 排在 agent 状态条之下——状态条是「此刻在做什么」，跟着消息流走；
 * 计划是「这一轮要做哪几件」，是这一轮的框架，压在输入框上方更稳。
 */
function TaskPlanPanel({
  todos,
  active,
  onClear,
}: {
  todos: { content: string; status: string }[];
  /** 是否正在运行；否则计划里未完成的步骤视为「已暂停」（用户停止或运行中断的残留）。 */
  active: boolean;
  /** 作废这份计划：面板消失，后续对话不再受它影响。运行期不提供（agent 正照着做）。 */
  onClear: () => void;
}) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === "completed").length;
  const hasIncomplete = done < todos.length;
  const running = active && todos.some((t) => t.status === "in_progress");
  // 不在运行 + 还有没做完的步骤 → 计划处于暂停态
  const paused = !active && hasIncomplete;
  return (
    <div className="shrink-0 border-t border-border bg-card">
      {/* 折叠开关与「作废计划」是两个独立按钮，不能嵌套：外层用 div 承载，避免 button 套 button */}
      <div className="flex items-center transition-colors hover:bg-accent">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 py-2 pl-4 text-left text-xs font-medium"
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
        <Button
          variant="ghost"
          size="icon"
          className="mr-2 ml-1 size-6 shrink-0 text-muted-foreground hover:text-foreground"
          title="Discard this plan"
          aria-label="Discard this plan"
          onClick={onClear}
        >
          <X className="size-3.5" />
        </Button>
      </div>
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
  mockMedia,
  onAnswer,
  onResolve,
}: {
  ask: NonNullable<ChatState["ask"]>;
  /** 画布开着测试模式：生成确认里注明这次不花钱 */
  mockMedia: boolean;
  onAnswer: (msg: string) => void;
  onResolve: (approve: boolean) => void;
}) {
  const [text, setText] = useState("");

  // 确认型（破坏性/消耗性操作）：只给「确认 / 取消」两个按钮，不填答案。
  // clear_canvas 走 destructive 红色语义；generate_media_node 是普通消耗确认走 primary。
  // 模型可一轮并行发多个（实测 6 个 generate_media_node）——整批列出、一次表态。
  if (CONFIRM_TOOLS.has(ask.tool)) {
    const destructive = ask.tool === "clear_canvas";
    const batch = ask.actions.length > 1;
    const label = (tool: string, text: string) =>
      tool === "clear_canvas"
        ? "This clears the whole canvas (every node and edge). It cannot be undone. Proceed?"
        : text;
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
          {mockMedia && ask.actions.some((a) => a.tool === "generate_media_node") && (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/60 bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
              <FlaskConical className="size-3 text-warning" aria-hidden />
              Mock, no cost
            </span>
          )}
          {batch && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {ask.actions.length} actions
            </span>
          )}
        </div>
        {batch ? (
          <ul className="max-h-32 space-y-1 overflow-y-auto text-sm text-muted-foreground">
            {ask.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2">
                <CircleDot className="mt-1 size-3 shrink-0" />
                {/* pre-line：save_skill 的确认文案第二行是技能说明 */}
                <span className="whitespace-pre-line">
                  {label(a.tool, a.label)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // pre-line：save_skill 的确认文案第二行是技能说明
          <p className="whitespace-pre-line text-sm text-muted-foreground">
            {label(ask.tool, ask.question)}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={() => onResolve(true)}
          >
            {destructive
              ? "Clear canvas"
              : batch
                ? `Approve all (${ask.actions.length})`
                : ask.tool === "save_skill"
                  ? "Save skill"
                  : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve(false)}>
            {batch ? "Cancel all" : "Cancel"}
          </Button>
        </div>
      </div>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAnswer(t);
    setText("");
  };

  // 问题是这张卡的正文，用正文色；选项是一列整宽的可点行——模型给的选项常是「名称 — 说明」的长句，
  // 胶囊按钮一行一个又不换行，长的被截掉、短的挤成一团，扫一眼看不出差别。
  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden />
          Agent asks
        </div>
        <p className="text-sm leading-relaxed whitespace-pre-line text-foreground">
          {ask.question}
        </p>
      </div>
      {ask.options.length > 0 && (
        <ul aria-label="Suggested answers" className="flex flex-col gap-1.5">
          {ask.options.map((o) => {
            const { title, detail } = splitOption(o);
            return (
              <li key={o}>
                <Button
                  variant="outline"
                  onClick={() => onAnswer(o)}
                  className="group/option h-auto w-full items-start justify-between gap-3 px-3 py-2 text-left font-normal whitespace-normal"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">
                      {title}
                    </span>
                    {detail && (
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {detail}
                      </span>
                    )}
                  </span>
                  {/* 点一下就直接作答（不是先选再确认）：箭头在悬停 / 聚焦时亮起，提示这一点 */}
                  <ArrowRight
                    className="mt-0.5 size-3.5 text-muted-foreground/0 transition-colors duration-150 group-hover/option:text-foreground group-focus-visible/option:text-foreground"
                    aria-hidden
                  />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {/* 自由作答：与底部输入框同一套形态（发送键内嵌右下、Enter 发送 / Shift+Enter 换行） */}
      <div className="flex items-end gap-1.5 rounded-lg border border-input bg-background py-1.5 pr-1.5 pl-3 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/30">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          aria-label="Your answer"
          placeholder={
            ask.options.length > 0
              ? "Or type your own answer…"
              : "Type your answer…"
          }
          className="max-h-32 min-h-0 flex-1 resize-none border-0 bg-transparent p-0 py-1 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        />
        <Button
          size="icon-sm"
          aria-label="Send answer"
          title="Send answer (Enter)"
          disabled={!text.trim()}
          onClick={submit}
          className="disabled:opacity-40"
        >
          <Send />
        </Button>
      </div>
    </div>
  );
}

/**
 * 选项拆成「名称 + 说明」两行：模型常写成 `Wan 3.0（fal）— 时长 2–30 秒…`。
 * 只认破折号（— / –）作分隔，免得把「16:9」「1-2 秒」这类内容误拆；没有分隔就整句当名称。
 */
function splitOption(option: string): { title: string; detail: string | null } {
  const m = /^(.+?)\s*[—–]\s*(.+)$/.exec(option);
  return m ? { title: m[1], detail: m[2] } : { title: option, detail: null };
}

export function CanvasChat({
  sessionId,
  chat,
  busy,
  sessionModel,
  sessionThinkingLevel,
  sessionApprovalMode,
  onSend,
  onStop,
  onAnswer,
  onResolve,
  onClearPlan,
  mockMedia = false,
  focusCount,
  onClearFocus,
}: {
  /** 当前会话；换会话时重置滚动状态（留白、跟随、首次定位）。 */
  sessionId: string | null;
  chat: ChatState;
  busy: boolean;
  /** 会话当前模型（初始化切换器）；null 时用默认。 */
  sessionModel?: string | null;
  /** 会话当前思考深度档位（初始化切换器）；null = 跟随模型默认（auto）。 */
  sessionThinkingLevel?: string | null;
  /** 会话的敏感操作审批模式（后端归一化后恒有值） */
  sessionApprovalMode?: CanvasApprovalMode;
  onSend: (
    text: string,
    model?: string,
    thinkingLevel?: ThinkingLevel,
    approvalMode?: CanvasApprovalMode,
    attachments?: MessageAttachment[],
  ) => void;
  onStop: () => void;
  onAnswer: (msg: string) => void;
  onResolve: (approve: boolean) => void;
  /** 作废当前任务计划（计划面板上的 ×）。 */
  onClearPlan: () => void;
  /** 画布开着测试模式（Mock）：生成确认卡片上注明不花钱 */
  mockMedia?: boolean;
  /** 「加入对话」圈定的节点数；>0 时输入框上方提示 agent 只看这些节点 */
  focusCount: number;
  /** 取消圈定，恢复关注整块画布 */
  onClearFocus: () => void;
}) {
  const [text, setText] = useState("");
  // agent 当前阶段：决定流末尾指示器显不显示、以哪种形态显示
  const phase = agentPhase(chat.items, busy);
  // 会话存的模型可能已下线（不在可选列表）→ 回退默认，避免发出被后端拒绝的模型名
  const [model, setModel] = useState(normalizeCanvasModel(sessionModel));
  // 快照异步加载 / 切换会话后，把切换器同步到该会话实际模型（render 期调整 state，
  // 规避 Next16 的 effect-setState 限制）。用户本地改选后 sessionModel 不变，不会被覆盖。
  const [seenSessionModel, setSeenSessionModel] = useState(sessionModel ?? null);
  if (sessionModel && sessionModel !== seenSessionModel) {
    setSeenSessionModel(sessionModel);
    setModel(normalizeCanvasModel(sessionModel));
  }
  // 思考深度：同上的同步套路（render 期调整 state，不用 effect）。
  // 存库的档位可能已不被当前模型支持（换过模型，或能力表更新——例如 gemini-3.6-flash 其实
  // 不接受关闭思考），一律先归一，避免切换器显示一个下拉里根本没有的档位。
  const [thinking, setThinking] = useState<ThinkingLevel>(() =>
    normalizeThinking(normalizeCanvasModel(sessionModel), sessionThinkingLevel),
  );
  // 审批模式：同上的 render 期同步套路。默认 review——放行是不可逆的，
  // 快照还没到手时不能先按"全自动"渲染。
  const [approval, setApproval] = useState<CanvasApprovalMode>(
    sessionApprovalMode ?? "review",
  );
  const [seenApproval, setSeenApproval] = useState(sessionApprovalMode ?? null);
  if (sessionApprovalMode && sessionApprovalMode !== seenApproval) {
    setSeenApproval(sessionApprovalMode);
    setApproval(sessionApprovalMode);
  }
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
  // 滚动编排：发送后把这条消息顶到视口顶部，回复在其下方生长而视图不动；
  // 底部留白只缩不涨；跟随底部默认关，只由「回到最新」按钮开启。
  // 旧实现是 bottomRef.scrollIntoView——它会顺带滚动每一个可滚祖先，是「整页被顶上去」
  // 那一类问题的根源；新实现只动 ScrollArea 自己的 viewport。
  const { contentRef, spacerRef, atLatest, armAnchor, jumpToLatest } =
    useChatScroll(chat.items, sessionId);

  // ——— 技能：输入 / 补全、工具条上的选择器、管理弹窗 ———
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skills = useCanvasSkills();
  const enabledSkills = (skills.data ?? []).filter((s) => s.enabled);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // 正在敲命令名（以 / 开头、还没空格）→ 按前缀过滤
  const query = slashQuery(text);
  const matches =
    query === null
      ? []
      : enabledSkills.filter((s) => s.name.startsWith(query));
  // Esc 收起后，同一段草稿不再弹（继续打字草稿变了才重新出现）
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const menuOpen = !busy && matches.length > 0 && dismissedFor !== text;
  const [activeIndex, setActiveIndex] = useState(0);
  const [seenQuery, setSeenQuery] = useState(query);
  if (seenQuery !== query) {
    setSeenQuery(query);
    setActiveIndex(0);
  }
  // 草稿以一个可用技能开头 → 输入框上方亮出「正在用的技能」条
  const leading = leadingSkill(text);
  const activeSkill = leading
    ? enabledSkills.find((s) => s.name === leading.name)
    : undefined;

  function pickSkill(name: string) {
    setText((t) => withSkill(t, name));
    inputRef.current?.focus();
  }

  // agent 存了新技能（save_skill 完成）→ 刷新列表，补全里马上能看到
  const queryClient = useQueryClient();
  const savedSkills = chat.items.filter(
    (it) => it.kind === "tool" && it.name === "save_skill" && it.done,
  ).length;
  useEffect(() => {
    if (savedSkills > 0) {
      void queryClient.invalidateQueries({ queryKey: CANVAS_SKILLS_KEY });
    }
  }, [savedSkills, queryClient]);

  // ——— 附件：回形针 / 拖拽 / 粘贴，选中即上传（同 Spark 输入框）———
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(sessionId, uploadCanvasAttachment);
  const [dragging, setDragging] = useState(false);
  // 上传中 / 有失败的附件时不让发：发出去的消息里会少东西
  const attachmentsBlocked =
    attachments.uploading ||
    attachments.items.some((it) => it.status === "error");
  const canSend =
    !busy &&
    !attachmentsBlocked &&
    (text.trim().length > 0 || attachments.ready.length > 0);

  function submit() {
    if (!canSend) return;
    armAnchor();
    onSend(text.trim(), model, thinking, approval, attachments.ready);
    setText("");
    attachments.clear();
  }

  /** 粘贴：剪贴板里有文件（截图、复制的图片）就当附件收下，不往输入框里贴 */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (busy || e.clipboardData.files.length === 0) return;
    e.preventDefault();
    attachments.add(e.clipboardData.files);
  }

  /** 拖拽文件进输入框：只认带文件的拖拽（拖一段文字进来照常） */
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (busy || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(true);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (busy || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    attachments.add(e.dataTransfer.files);
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
      {/* min-h-0 关键：让滚动区在 flex 列里可收缩并内部滚动，而不是撑高整列溢出屏幕。
          relative 给「回到最新」按钮定位——它必须在滚动视口之外，否则会跟着内容滚走。 */}
      <div className="relative min-h-0 flex-1">
        {/* --chat-top-gap：发送后这条用户消息距视口顶的留白，数字只在这里出现。
            面板矮的时候 hook 会按视口高度自动封顶，不会吃掉小半屏。 */}
        <ScrollArea className="h-full px-4 [--chat-top-gap:68px]">
          <div ref={contentRef} className="flex flex-col gap-2.5 py-4">
            {renderItems(chat.items)}
            {chat.ask && (
              <AskPanel
                ask={chat.ask}
                mockMedia={mockMedia}
                onAnswer={onAnswer}
                onResolve={onResolve}
              />
            )}
          </div>
          {/* 底部动态留白：撑出「把刚发的消息顶到视口顶部」所需的滚动余量。
              回复每长一截就等量收窄，填满一屏归零；同一轮内只缩不涨。 */}
          <div ref={spacerRef} aria-hidden />
        </ScrollArea>
        {!atLatest && <JumpToLatest onClick={jumpToLatest} />}
      </div>

      {/* agent 状态条：紧贴消息流下沿，不随消息滚走——执行期间要始终看得见。
          排在任务计划之上：它讲的是「此刻在做什么」，是最后一条消息的延续；
          任务计划讲的是「整轮要做哪几件」，属于这一轮的框架，贴着输入框更稳。
          不给底色也不描边——它是消息区的延续，不是独立面板，多一道分隔线只会把聊天区切碎。
          刻意不带 key={phase}：执行中阶段切得很勤，重挂载会让文案每次都从头淡入，
          反而比阶段本身更抢眼。保持挂载，只换 animation / phrases。
          左内边距比常规 px-4 少一点，是因为指示器自带光晕呼吸位，补齐后正好对上消息区。 */}
      {!chat.ask && phase && (
        <div className="shrink-0 py-2 pr-4 pl-2">
          <CanvasThinkingIndicator
            size={18}
            animation={PHASE_UI[phase].animation}
            // 开跑前在读本轮附件：这是确定在做的事，直接报进度，不轮换俏皮话
            phrases={
              chat.reading
                ? [
                    `Reading attachments ${chat.reading.done}/${chat.reading.total}`,
                  ]
                : PHASE_UI[phase].phrases
            }
          />
        </div>
      )}

      {planTodos && planTodos.length > 0 && !planAllDone && (
        <TaskPlanPanel todos={planTodos} active={busy} onClear={onClearPlan} />
      )}

      <SkillsDialog
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        onUse={pickSkill}
      />

      <div className="shrink-0 border-t border-border p-3">
        {/* 圈定提示：画布上圈了节点，这一轮 agent 的画布上下文就只有它们。
            放在输入框正上方而不是画布角落——它改变的是"这条消息会被怎么理解"，
            属于输入的一部分（同 IM 里的引用条）。 */}
        {focusCount > 0 && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-[11px] text-primary">
            <MessagesSquare className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              Agent sees only the {focusCount} node
              {focusCount > 1 ? "s" : ""} you added
            </span>
            <button
              type="button"
              onClick={onClearFocus}
              className="shrink-0 rounded-sm px-1 font-medium underline-offset-2 hover:underline"
            >
              Clear
            </button>
          </div>
        )}
        {activeSkill && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Wand2 className="size-3 shrink-0 text-primary" aria-hidden />
            <span className="shrink-0 font-medium text-foreground">
              {activeSkill.name}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {activeSkill.description}
            </span>
            <button
              type="button"
              aria-label="Don't use this skill"
              title="Don't use this skill"
              onClick={() => {
                setText((t) => withoutSkill(t));
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-background hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        {/* 一体化 composer：容器承接焦点态（primary 描边 + 焦点环 + 轻抬升），
            textarea 去边框内嵌、随输入自动增高（field-sizing-content），发送键内嵌右下。
            relative：技能补全菜单贴着它的上沿浮出 */}
        <div
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "group relative rounded-xl border border-input bg-background px-3 py-2.5 transition-all duration-200",
            "focus-within:border-primary/50 focus-within:shadow-sm focus-within:ring-3 focus-within:ring-ring/40",
            busy && "opacity-80",
            dragging && "border-ring bg-accent",
          )}
        >
          {menuOpen && (
            <SkillCommandMenu
              skills={matches}
              activeIndex={activeIndex}
              onPick={pickSkill}
              onHover={setActiveIndex}
            />
          )}
          <ComposerAttachments
            items={attachments.items}
            onRemove={attachments.remove}
            className="px-0 pt-0 pb-2"
          />
          <Textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (menuOpen) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = matches.length;
                  setActiveIndex((i) =>
                    e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n,
                  );
                  return;
                }
                // 菜单开着时 Enter / Tab 是「选中」而不是发送半截命令
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  pickSkill((matches[activeIndex] ?? matches[0]).name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissedFor(text);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              busy
                ? "Agent running…"
                : "Describe the workflow, or type / for skills"
            }
            disabled={busy}
            rows={1}
            className="max-h-40 min-h-0 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent"
          />
          {/* items-end：左侧换行成两排时，发送键贴着最后一排 */}
          <div className="mt-2 flex items-end justify-between gap-2">
            {/* flex-wrap：面板窄时切换器折到第二排，而不是压到发送键上 */}
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Attach files"
                title="Attach images, videos or audio"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip />
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) attachments.add(e.target.files);
                  // 清空值：同一个文件移除后还能再选一次
                  e.target.value = "";
                }}
              />
              <SkillPicker
                skills={enabledSkills}
                disabled={busy}
                onPick={pickSkill}
                onManage={() => setSkillsOpen(true)}
              />
              <CanvasModelSwitcher
                value={model}
                onChange={changeModel}
                disabled={busy}
              />
              <ThinkingSwitcher
                model={model}
                value={thinking}
                onChange={setThinking}
                disabled={busy}
              />
              <CanvasApprovalSwitcher
                value={approval}
                onChange={setApproval}
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
                disabled={!canSend}
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
