"use client";

import { Bot, Brain, ChevronDown, ChevronRight, ListChecks, Loader, PanelRight, Wrench } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ThreadItem } from "../lib/thread";
import { Elapsed } from "./elapsed";
import { Markdown } from "./markdown";
import { TOOL_ICON, type ToolItem, toolLabel, toolSummary } from "./tool-chip";

export type ReasoningItem = Extract<ThreadItem, { kind: "reasoning" }>;
export type ActivityItem = ToolItem | ReasoningItem;
/** 渲染 task chip 展开后的子线程（由 ThreadRows 注入，避免活动组与行渲染互相引用） */
export type RenderSub = (items: ThreadItem[], live: boolean) => ReactNode;

/** 距底部小于这个值（px）视为「在看最新」，继续跟随；用户往上翻超过它就停止跟随。 */
const FOLLOW_SLACK = 16;

function isRunning(it: ActivityItem): boolean {
  return it.kind === "tool" ? !it.done : it.streaming;
}

/**
 * 相邻的思考与工具调用合成一组：组头「Working · 26s」/「Worked for 1m 5s · 7 steps」，可整组收起。
 * 进行中默认展开、结束后自动收起；用户手动点过就以手动状态为准。
 * 组里只有一项（单个工具或单段思考）时不要组头，直接渲染那一行。
 */
export function ActivityGroup({
  items,
  live,
  activeDetailId,
  onOpenDetail,
  renderSub,
}: {
  items: ActivityItem[];
  /** 列表末尾且本轮还在跑：组头按「进行中」显示 */
  live: boolean;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  renderSub: RenderSub;
}) {
  const { t } = useTranslation();
  const [manual, setManual] = useState<boolean | null>(null);

  if (items.length === 1) {
    return (
      <ol>
        <ActivityRow item={items[0]} activeDetailId={activeDetailId} onOpenDetail={onOpenDetail} renderSub={renderSub} />
      </ol>
    );
  }

  const running = live || items.some(isRunning);
  const open = manual ?? running;
  const steps = items.filter((i) => i.kind === "tool").length;
  // 组耗时 = 第一项开始 → 最后一项结束（墙钟跨度）；缺时间的旧数据不显示
  const starts = items.flatMap((i) => (i.startedAt != null ? [i.startedAt] : []));
  const ends = items.flatMap((i) => (i.endedAt != null ? [i.endedAt] : []));
  const startedAt = starts.length ? Math.min(...starts) : null;
  const endedAt = ends.length ? Math.max(...ends) : null;
  const stepLabel = steps ? t("chat.activity.steps", { count: steps }) : t("chat.activity.thinking");

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 pb-2 text-left font-medium transition-colors",
          open && "border-b",
          running ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {running ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="tabular-nums">
          {running ? (
            <>
              {t("chat.activity.working")}
              {startedAt != null && (
                <>
                  {" · "}
                  <Elapsed startedAt={startedAt} />
                </>
              )}
            </>
          ) : (
            <>
              {startedAt != null && endedAt != null ? (
                <>
                  {t("chat.activity.workedFor")} <Elapsed startedAt={startedAt} endedAt={endedAt} />
                </>
              ) : (
                t("chat.activity.worked")
              )}
              {` · ${stepLabel}`}
            </>
          )}
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>
      {open && (
        <ol className="space-y-2.5 pt-2.5">
          {items.map((it) => (
            <ActivityRow
              key={it.id}
              item={it}
              activeDetailId={activeDetailId}
              onOpenDetail={onOpenDetail}
              renderSub={renderSub}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ActivityRow({
  item,
  activeDetailId,
  onOpenDetail,
  renderSub,
}: {
  item: ActivityItem;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  renderSub: RenderSub;
}) {
  if (item.kind === "reasoning") return <ThoughtRow item={item} />;
  if (item.name === "task") {
    return (
      <TaskRow item={item} active={activeDetailId === item.id} onOpenDetail={onOpenDetail} renderSub={renderSub} />
    );
  }
  return <ToolRow item={item} active={activeDetailId === item.id} onOpenDetail={onOpenDetail} />;
}

/** task 调用参数 `{ description, subagent_type }` 里给人看的两段 */
function taskArgs(args: unknown): { name: string; description: string } {
  if (!args || typeof args !== "object") return { name: "", description: "" };
  const name = "subagent_type" in args && typeof args.subagent_type === "string" ? args.subagent_type : "";
  const description = "description" in args && typeof args.description === "string" ? args.description : "";
  return { name, description: description.replace(/\s+/g, " ").trim() };
}

/**
 * 委派子 agent 的 task 调用：一行「子 agent 名 + 任务说明 + 耗时」，点开看子 agent 的嵌套过程（思考 / 工具 / 正文，
 * 复用主线程的行渲染）；右侧按钮打开详情面板看参数与最终结果。
 * 进行中默认展开、结束后自动收起；手动点过以手动状态为准（同思考行）。
 */
function TaskRow({
  item,
  active,
  onOpenDetail,
  renderSub,
}: {
  item: ToolItem;
  active: boolean;
  onOpenDetail: (id: string) => void;
  renderSub: RenderSub;
}) {
  const { t } = useTranslation();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? !item.done;
  const { name, description } = taskArgs(item.args);
  const subItems = item.sub?.items.filter((it) => it.kind !== "plan") ?? [];
  return (
    <li className="space-y-2.5">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setManual(!open)}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left text-xs transition-colors hover:text-foreground",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {item.done ? <Bot className="size-3.5 shrink-0" /> : <Loader className="size-3.5 shrink-0 animate-spin" />}
          <span className={cn("shrink-0 font-medium", !item.done && "text-foreground")}>
            {name || t("chat.activity.subagent")}
          </span>
          {description && (
            <span className="min-w-0 truncate" title={description}>
              {description}
            </span>
          )}
          <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/70">
            {item.startedAt != null &&
              (item.done ? (
                item.endedAt != null && <Elapsed startedAt={item.startedAt} endedAt={item.endedAt} />
              ) : (
                <Elapsed startedAt={item.startedAt} />
              ))}
          </span>
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")}
          />
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t("chat.activity.taskDetail")}
          title={t("chat.activity.taskDetail")}
          onClick={() => onOpenDetail(item.id)}
        >
          <PanelRight />
        </Button>
      </div>
      {open && (
        <div className="ml-1.5 space-y-4 border-l-2 pl-4 text-sm" data-testid="subagent-thread">
          {subItems.length > 0 ? (
            renderSub(subItems, !item.done)
          ) : (
            <p className="text-xs text-muted-foreground">
              {item.done ? t("chat.activity.subagentEmpty") : t("chat.activity.subagentStarting")}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** 一步工具调用：图标 + 工具名 + 参数摘要（路径 / 命令）+ 耗时；点击打开右侧详情面板。 */
function ToolRow({
  item,
  active,
  onOpenDetail,
}: {
  item: ToolItem;
  active: boolean;
  onOpenDetail: (id: string) => void;
}) {
  const Icon = TOOL_ICON[item.name] ?? Wrench;
  const summary = toolSummary(item.name, item.args);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenDetail(item.id)}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left text-xs transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {item.done ? (
          <Icon className="size-3.5 shrink-0" />
        ) : (
          <Loader className="size-3.5 shrink-0 animate-spin" />
        )}
        <span className={cn("shrink-0 font-medium", !item.done && "text-foreground")}>{toolLabel(item.name)}</span>
        {summary && (
          <span className="min-w-0 truncate font-mono" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground/70">
          {item.startedAt != null &&
            (item.done ? (
              item.endedAt != null && <Elapsed startedAt={item.startedAt} endedAt={item.endedAt} />
            ) : (
              <Elapsed startedAt={item.startedAt} />
            ))}
        </span>
      </button>
    </li>
  );
}

/**
 * 一段思考：一行「Thought for 3.4s · 摘要」，点开看全文。
 * 思考中默认展开、内容区有最高高度，新文字到来时自动滚到最新处；用户在框内往上翻就暂停跟随。
 * 结束后自动收起；手动点过以手动状态为准。只滚这个框自己的 scrollTop，不用 scrollIntoView。
 */
function ThoughtRow({ item }: { item: ReasoningItem }) {
  const { t } = useTranslation();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? item.streaming;
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !item.streaming || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [item.text, item.streaming, open]);

  const firstLine = item.text.split("\n").find((l) => l.trim())?.replace(/\*\*/g, "").trim() ?? "";
  return (
    <li className="space-y-1.5">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {item.streaming ? (
          <Loader className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Brain className="size-3.5 shrink-0" />
        )}
        <span className={cn("shrink-0 font-medium", item.streaming && "text-foreground")}>
          {/* 耗时：起点 = 本次模型调用开始，进行中走字、收口后定格；旧数据没有时间只显示文案 */}
          {item.startedAt == null ? (
            item.streaming ? t("chat.activity.thinkingNow") : t("chat.activity.thought")
          ) : item.streaming ? (
            <>
              {t("chat.activity.thinkingNow")} <Elapsed startedAt={item.startedAt} />
            </>
          ) : (
            <>
              {t("chat.activity.thoughtFor")} <Elapsed startedAt={item.startedAt} endedAt={item.endedAt ?? item.startedAt} />
            </>
          )}
        </span>
        {!open && firstLine && <span className="min-w-0 truncate text-muted-foreground/70">{firstLine}</span>}
        <ChevronRight
          className={cn(
            "ml-auto size-3 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-reasoning-body
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
          }}
          className="ml-5.5 max-h-64 overflow-y-auto overscroll-contain border-l-2 pl-3"
        >
          {/* 思考摘要是 Markdown（Gemini 以「**小标题**」分段）：复用对话正文的渲染，别把星号原样露出来 */}
          <Markdown className="text-xs break-words text-muted-foreground [&_p]:my-1.5 [&_strong]:font-medium [&_strong]:text-foreground/80">
            {item.text}
          </Markdown>
        </div>
      )}
    </li>
  );
}
