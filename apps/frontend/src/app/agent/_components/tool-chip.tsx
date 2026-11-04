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
  Mail,
  SquareTerminal,
  TextSearch,
  type LucideIcon,
} from "lucide-react";

import type { ThreadItem } from "../_lib/thread";

export type ToolItem = Extract<ThreadItem, { kind: "tool" }>;

/** 工具名 → 图标（对话页活动组的工具行用） */
export const TOOL_ICON: Record<string, LucideIcon> = {
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

/** 界面上显示的工具名：后端名字保持不变，只换给人看的叫法（execute 实际跑的就是 bash 命令）。 */
const TOOL_LABEL: Record<string, string> = { execute: "bash" };

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

/**
 * chip 上紧跟工具名的摘要：
 * - 文件类工具（read_file / write_file / edit_file 等）显示参数里的 file_path；
 * - execute 显示所执行的命令，多行/连续空白折成一行（chip 只占一行，超出由 truncate 省略）。
 * 其余工具无摘要返回 null。
 */
export function toolSummary(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (name === "execute") {
    return typeof a.command === "string" ? a.command.replace(/\s+/g, " ").trim() || null : null;
  }
  return typeof a.file_path === "string" ? a.file_path : null;
}
