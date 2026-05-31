"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  Slash,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCommands } from "@/lib/api";

import type { Approval, Decision, ThreadItem } from "../_lib/thread";
import { ApprovalCard } from "./approval-card";
import { ChatMessage } from "./chat-message";

export function ChatThread({
  title,
  items,
  approval,
  busy,
  isLoading,
  isNewChat,
  activeDetailId,
  onOpenDetail,
  onDecide,
  onSend,
  panelOpen,
  onTogglePanel,
  onOpenSidebar,
}: {
  title: string;
  items: ThreadItem[];
  approval: Approval | null;
  busy: boolean;
  isLoading: boolean;
  isNewChat: boolean;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  onDecide: (d: Decision) => void;
  onSend: (text: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenSidebar: () => void;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 可用命令（/ 自动补全）
  const { data: commands = [] } = useQuery({
    queryKey: ["commands"],
    queryFn: listCommands,
    staleTime: 5 * 60_000,
  });

  // 正在输入命令名（以 / 开头且还没空格）→ 弹补全
  const cmdPrefix =
    draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1) : null;
  const matches =
    cmdPrefix === null
      ? []
      : commands.filter((c) =>
          c.name.toLowerCase().startsWith(cmdPrefix.toLowerCase()),
        );
  const showCmdMenu = !busy && cmdPrefix !== null && matches.length > 0;

  // 新消息 / 审批出现时滚动到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, approval]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  }

  function pickCommand(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // 补全打开时 Enter 选中首个命令，而不是发送半截命令
      if (showCmdMenu) pickCommand(matches[0].name);
      else submit();
    }
  }

  // 按 domain 分组展示
  const grouped = matches.reduce<Record<string, typeof matches>>((acc, c) => {
    (acc[c.domain] ??= []).push(c);
    return acc;
  }, {});

  const showEmpty = !isLoading && items.length === 0;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-background">
      {/* 顶栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 lg:px-5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="打开会话列表"
            onClick={onOpenSidebar}
          >
            <PanelLeft />
          </Button>
          <h1 className="truncate text-sm font-semibold tracking-tight">
            {title}
          </h1>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={panelOpen ? "收起详情面板" : "展开详情面板"}
                onClick={onTogglePanel}
              />
            }
          >
            {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </TooltipTrigger>
          <TooltipContent>{panelOpen ? "收起详情" : "展开详情"}</TooltipContent>
        </Tooltip>
      </header>

      {/* 消息流 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-8">
          {showEmpty ? (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Sparkles className="size-6" />
              </div>
              <p className="text-base font-medium">
                {isNewChat ? "开始一个新对话" : "这个会话还没有内容"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                把目标告诉 Agent，它会拆解任务并逐步执行。需要发邮件等敏感操作时会先请你审批。
              </p>
            </div>
          ) : (
            <>
              {items.map((item) => (
                <ChatMessage
                  key={item.id}
                  item={item}
                  activeDetailId={activeDetailId}
                  onOpenDetail={onOpenDetail}
                />
              ))}
              {approval && (
                <div className="pl-10">
                  <ApprovalCard approval={approval} onDecide={onDecide} />
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* 输入区 */}
      <div className="shrink-0 px-5 pb-4">
        <div className="relative mx-auto max-w-3xl">
          {/* 命令补全面板（输入 / 时浮在输入框上方，按 domain 分组）*/}
          {showCmdMenu && (
            <div className="absolute bottom-full mb-2 max-h-72 w-full overflow-y-auto rounded-xl border bg-popover p-1.5 shadow-lg">
              {Object.entries(grouped).map(([domain, cmds]) => (
                <div key={domain}>
                  <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {domain}
                  </div>
                  {cmds.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault(); // 避免 textarea 失焦
                        pickCommand(c.name);
                      }}
                      className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                    >
                      <Slash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {c.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="relative rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring">
            <Textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={busy ? "Agent 正在处理…" : "给 Agent 发消息…（试试输入 /）"}
              className="max-h-40 min-h-0 resize-none border-0 bg-transparent px-4 py-3.5 pr-14 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
            <Button
              size="icon-sm"
              aria-label="发送"
              disabled={busy || !draft.trim()}
              onClick={submit}
              className="absolute right-2.5 bottom-2.5 rounded-lg"
            >
              <ArrowUp />
            </Button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Agent 可能会出错，请核对重要信息。
          </p>
        </div>
      </div>
    </section>
  );
}
