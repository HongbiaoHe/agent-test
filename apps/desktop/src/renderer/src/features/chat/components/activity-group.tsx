"use client";

import { Brain, ChevronDown, ChevronRight, ListChecks, Loader, Wrench } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { ThreadItem } from "../lib/thread";
import { Elapsed } from "./elapsed";
import { Markdown } from "./markdown";
import { TOOL_ICON, type ToolItem, toolLabel, toolSummary } from "./tool-chip";

export type ReasoningItem = Extract<ThreadItem, { kind: "reasoning" }>;
export type ActivityItem = ToolItem | ReasoningItem;

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
}: {
  items: ActivityItem[];
  /** 列表末尾且本轮还在跑：组头按「进行中」显示 */
  live: boolean;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
}) {
  const [manual, setManual] = useState<boolean | null>(null);

  if (items.length === 1) {
    return (
      <ol>
        <ActivityRow item={items[0]} activeDetailId={activeDetailId} onOpenDetail={onOpenDetail} />
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
  const stepLabel = steps ? `${steps} ${steps === 1 ? "step" : "steps"}` : "thinking";

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
              Working
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
                  Worked for <Elapsed startedAt={startedAt} endedAt={endedAt} />
                </>
              ) : (
                "Worked"
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
            <ActivityRow key={it.id} item={it} activeDetailId={activeDetailId} onOpenDetail={onOpenDetail} />
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
}: {
  item: ActivityItem;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
}) {
  return item.kind === "tool" ? (
    <ToolRow item={item} active={activeDetailId === item.id} onOpenDetail={onOpenDetail} />
  ) : (
    <ThoughtRow item={item} />
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
            item.streaming ? "Thinking…" : "Thought"
          ) : item.streaming ? (
            <>
              Thinking… <Elapsed startedAt={item.startedAt} />
            </>
          ) : (
            <>
              Thought for <Elapsed startedAt={item.startedAt} endedAt={item.endedAt ?? item.startedAt} />
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
