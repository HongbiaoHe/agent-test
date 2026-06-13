"use client";

import { useQuery } from "@tanstack/react-query";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCommands } from "@/lib/api";

import type { ThreadItem } from "../_lib/thread";
import { Markdown } from "./markdown";

export function ChatMessage({ item }: { item: ThreadItem }) {
  if (item.kind === "user") {
    return <UserMessage text={item.text} />;
  }

  // 助手消息不带头像：内容直接靠左，与工具组/媒体卡/审批卡同列对齐
  if (item.kind === "assistant") {
    return (
      <div className="min-w-0">
        <Markdown>{item.text}</Markdown>
        {item.streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-foreground/60" />
        )}
      </div>
    );
  }

  // 工具调用（含连续多个的聚合）由 ChatThread 收集后交给 ToolGroup 渲染，此处不处理。

  if (item.kind === "error") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {item.text}
      </div>
    );
  }

  // plan 由输入框上方的固定面板渲染（见 TaskPlanPanel），此处不再展示。
  return null;
}

/**
 * 用户消息气泡。若消息以 `/命令` 开头且命中已知命令（与输入框补全同源），
 * 将该命令渲染为高亮 chip，hover 展示其分类（Built-in/GitHub）/ 名称 / 描述。
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
                    {command.kind === "builtin" ? "Built-in" : "GitHub"}
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
