"use client";

import {
  CloudSun,
  ListChecks,
  Loader,
  Mail,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { TodoList } from "@/components/agent/todo-list";
import { cn } from "@/lib/utils";

import type { ThreadItem } from "../_lib/thread";

const TOOL_ICON: Record<string, LucideIcon> = {
  send_email: Mail,
  get_weather: CloudSun,
};

/** 助手侧内容的左缩进，对齐头像（size-7 + gap-3 ≈ pl-10）。 */
const INDENT = "pl-10";

export function ChatMessage({
  item,
  activeDetailId,
  onOpenDetail,
}: {
  item: ThreadItem;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
}) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {item.text}
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return (
      <div className="flex gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
            {item.text}
            {item.streaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />
            )}
          </p>
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    const Icon = TOOL_ICON[item.name] ?? Wrench;
    const active = activeDetailId === item.id;
    return (
      <div className={INDENT}>
        <button
          type="button"
          onClick={() => onOpenDetail(item.id)}
          className={cn(
            "inline-flex max-w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
            active
              ? "border-ring bg-accent"
              : "bg-card hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {item.done ? (
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="truncate font-medium">{item.name}</span>
          <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
            {item.done ? "工具" : "调用中"}
          </span>
        </button>
      </div>
    );
  }

  if (item.kind === "plan") {
    return (
      <div className={INDENT}>
        <div className="rounded-xl border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ListChecks className="size-3.5" />
            任务计划
          </div>
          <TodoList todos={item.todos} />
        </div>
      </div>
    );
  }

  // error
  return (
    <div className={INDENT}>
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {item.text}
      </div>
    </div>
  );
}
