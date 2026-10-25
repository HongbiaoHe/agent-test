"use client";

import { useQuery } from "@tanstack/react-query";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MessageAttachments } from "@/components/attachments/message-attachments";
import { ErrorNotice } from "@/components/chat/error-notice";
import {
  listCommands,
  type MessageAttachment,
  type SkillKind,
} from "@/lib/api";

import { useNow } from "../_hooks/use-now";
import type { ThreadItem } from "../_lib/thread";
import { formatFullDateTime, formatMessageTime } from "../_lib/time";
import { Markdown } from "./markdown";

const CMD_KIND_LABEL: Record<SkillKind, string> = {
  builtin: "Built-in",
  github: "GitHub",
  custom: "Custom",
};

export function ChatMessage({ item }: { item: ThreadItem }) {
  if (item.kind === "user") {
    return <UserMessage text={item.text} attachments={item.attachments} at={item.at} />;
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
    return <ErrorNotice message={item.text} />;
  }

  // plan 由输入框上方的固定面板渲染（见 TaskPlanPanel），此处不再展示。
  return null;
}

/**
 * 用户消息气泡。若消息以 `/命令` 开头且命中已知命令（与输入框补全同源），
 * 将该命令渲染为高亮 chip，hover 展示其分类（Built-in/GitHub/Custom）/ 名称 / 描述。
 */
function UserMessage({
  text,
  attachments,
  at,
}: {
  text: string;
  attachments: MessageAttachment[];
  at?: number;
}) {
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
    // data-chat-anchor：发送后 useChatScroll 靠它把这条消息顶到视口顶部（取最后一个）
    // 附件在气泡上方右对齐；只发附件时没有文字气泡。
    // 发送时刻 hover 才显示，放在最后一块（气泡 / 附件）左侧，不占额外行高
    <div data-chat-anchor className="group flex flex-col items-end gap-2">
      {text ? (
        <MessageAttachments attachments={attachments} />
      ) : (
        <div className="flex items-end gap-2">
          {at != null && <MessageTime at={at} />}
          <MessageAttachments attachments={attachments} />
        </div>
      )}
      {text && (
        <div className="flex max-w-[80%] items-end justify-end gap-2">
          {at != null && <MessageTime at={at} />}
          <div className="min-w-0 rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
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
                        {CMD_KIND_LABEL[command.kind]}
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
      )}
    </div>
  );
}

/** 用户消息的发送时刻：hover 消息（或键盘聚焦到它）才淡入，再 hover 它看完整日期时间。 */
function MessageTime({ at }: { at: number }) {
  // 只用来判断「是不是今天」，不需要走字
  const now = useNow(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={new Date(at).toISOString()}
            className="shrink-0 cursor-default pb-1 text-[11px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          />
        }
      >
        {formatMessageTime(at, now)}
      </TooltipTrigger>
      <TooltipContent side="top">{formatFullDateTime(at)}</TooltipContent>
    </Tooltip>
  );
}
