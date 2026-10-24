"use client";

import { Brain, ChevronDown, Loader } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import type { ThreadItem } from "../_lib/thread";
import { Elapsed } from "./elapsed";

type ReasoningItem = Extract<ThreadItem, { kind: "reasoning" }>;

/** 距底部小于这个值（px）视为「在看最新」，继续跟随；用户往上翻超过它就停止跟随。 */
const FOLLOW_SLACK = 16;

/**
 * 思考过程块（与工具组同款折叠壳）：
 * - 思考中默认展开，内容区有最高高度，新文字到来时自动滚到最新处；
 *   用户在框内往上翻就暂停跟随，翻回底部再恢复。
 * - 思考结束（其后第一个事件到来，reducer 置 streaming=false）自动收起；历史记录默认收起。
 * - 用户手动点过之后以手动状态为准，不再被自动展开/收起打断。
 *
 * 只滚这个框自己的 scrollTop，不用 scrollIntoView——后者会连带滚动外层聊天视口与满屏外壳。
 */
export function ReasoningBlock({ item }: { item: ReasoningItem }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? item.streaming;
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  // 布局后、绘制前把框滚到底：新文字出现的同一帧就在视野里，不会先闪一下旧位置
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !item.streaming || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [item.text, item.streaming, open]);

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {item.streaming ? (
          <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {/* 耗时：起点 = 本次模型调用开始，进行中走字、收口后定格；旧数据没有时间只显示文案 */}
          {item.startedAt == null ? (
            item.streaming ? "Thinking…" : "Thought process"
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
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-reasoning-body
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
          }}
          className="max-h-64 overflow-y-auto overscroll-contain border-t px-3 py-2"
        >
          <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {item.text}
          </p>
        </div>
      )}
    </div>
  );
}
