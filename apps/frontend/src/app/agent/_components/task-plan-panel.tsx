"use client";

import { ChevronDown, ListChecks } from "lucide-react";
import { useState } from "react";

import { TodoList, type Todo } from "@/components/agent/todo-list";
import { cn } from "@/lib/utils";

/**
 * 任务计划面板：固定在输入框上方，可折叠/展开（默认展开），
 * 展开时内容超过最大高度则内部滚动。
 */
export function TaskPlanPanel({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;

  const done = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListChecks className="size-3.5 shrink-0" />
        <span>任务计划</span>
        <span className="text-muted-foreground/70">
          {done}/{todos.length}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 transition-transform",
            open ? "" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="max-h-52 overflow-y-auto border-t px-3 py-2.5">
          <TodoList todos={todos} />
        </div>
      )}
    </div>
  );
}
