"use client";

import {
  Bot,
  CloudSun,
  FilePen,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderSearch,
  ListTodo,
  Loader,
  Mail,
  SquareTerminal,
  TextSearch,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { ThreadItem } from "../_lib/thread";

export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

const TOOL_ICON: Record<string, LucideIcon> = {
  ls: FolderOpen,
  read_file: FileText,
  write_file: FilePlus2,
  edit_file: FilePen,
  glob: FolderSearch,
  grep: TextSearch,
  execute: SquareTerminal,
  write_todos: ListTodo,
  task: Bot,
  send_email: Mail,
  get_weather: CloudSun,
};

/**
 * 文件类工具（read_file / write_file / edit_file 等）的参数统一带 file_path，
 * 返回完整路径显示在 chip 上；非文件工具无 file_path 时返回 null。
 */
export function toolFilePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const path = (args as Record<string, unknown>).file_path;
  return typeof path === "string" ? path : null;
}

/** 单个工具调用 chip：点击打开右侧详情面板；done=false 时图标转圈、标签显示「cooking…」。 */
export function ToolChip({
  item,
  active,
  onOpenDetail,
}: {
  item: ToolItem;
  active: boolean;
  onOpenDetail: (id: string) => void;
}) {
  const Icon = TOOL_ICON[item.name] ?? Wrench;
  const path = toolFilePath(item.args);
  return (
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
      <span className="shrink-0 font-medium">{item.name}</span>
      {path && (
        <span className="truncate font-mono text-muted-foreground" title={path}>
          {path}
        </span>
      )}
      <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
        {item.done ? "tool" : "cooking…"}
      </span>
    </button>
  );
}
