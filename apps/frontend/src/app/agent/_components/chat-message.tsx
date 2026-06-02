"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CloudSun,
  Loader,
  Mail,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCommands } from "@/lib/api";
import { cn } from "@/lib/utils";

import type { ThreadItem } from "../_lib/thread";
import { Markdown } from "./markdown";

const TOOL_ICON: Record<string, LucideIcon> = {
  send_email: Mail,
  get_weather: CloudSun,
};

/**
 * 文件类工具（read_file / write_file / edit_file 等）的参数统一带 file_path，
 * 返回完整路径显示在 chip 上；非文件工具无 file_path 时返回 null。
 */
function filePath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const path = (args as Record<string, unknown>).file_path;
  return typeof path === "string" ? path : null;
}

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
    return <UserMessage text={item.text} />;
  }

  if (item.kind === "assistant") {
    return (
      <div className="flex gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <Markdown>{item.text}</Markdown>
          {item.streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    const Icon = TOOL_ICON[item.name] ?? Wrench;
    const active = activeDetailId === item.id;
    const path = filePath(item.args);
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
          <span className="shrink-0 font-medium">{item.name}</span>
          {path && (
            <span
              className="truncate font-mono text-muted-foreground"
              title={path}
            >
              {path}
            </span>
          )}
          <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
            {item.done ? "工具" : "调用中"}
          </span>
        </button>
      </div>
    );
  }

  if (item.kind === "error") {
    return (
      <div className={INDENT}>
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {item.text}
        </div>
      </div>
    );
  }

  // plan 由输入框上方的固定面板渲染（见 TaskPlanPanel），此处不再展示。
  return null;
}

/**
 * 用户消息气泡。若消息以 `/命令` 开头且命中已知命令（与输入框补全同源），
 * 将该命令渲染为高亮 chip，hover 展示其 domain / 名称 / 描述。
 */
function UserMessage({ text }: { text: string }) {
  // 与 ChatThread 的补全共用同一缓存（queryKey 一致，不会重复请求）
  const { data: commands = [] } = useQuery({
    queryKey: ["commands"],
    queryFn: listCommands,
    staleTime: 5 * 60_000,
  });

  // 开头第一个 token 形如 `/xxx`，其余（含前导空格/换行）原样保留
  const match = text.match(/^\/(\S+)([\s\S]*)$/);
  const command = match
    ? commands.find((c) => c.name.toLowerCase() === match[1].toLowerCase())
    : undefined;

  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        {command ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-help rounded-md bg-primary px-1.5 py-px align-baseline font-mono text-[0.85em] font-medium text-primary-foreground transition-colors hover:bg-primary/90" />
                }
              >
                /{command.name}
              </TooltipTrigger>
              <TooltipContent side="top" align="start" className="max-w-xs">
                <span className="flex flex-col gap-1 text-left">
                  <span className="text-[10px] font-medium tracking-wide text-background/60 uppercase">
                    {command.domain}
                  </span>
                  <span className="font-mono text-xs font-semibold">
                    /{command.name}
                  </span>
                  <span className="block max-h-48 overflow-y-auto leading-snug text-background/80">
                    {command.description}
                  </span>
                </span>
              </TooltipContent>
            </Tooltip>
            {match![2]}
          </>
        ) : (
          text
        )}
      </div>
    </div>
  );
}
