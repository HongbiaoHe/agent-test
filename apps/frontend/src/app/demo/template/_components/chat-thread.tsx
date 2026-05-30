"use client";

import {
  ArrowUp,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type { Detail, Message } from "../_data/mock";
import { ChatMessage } from "./chat-message";

export function ChatThread({
  title,
  messages,
  details,
  activeDetailId,
  onOpenDetail,
  panelOpen,
  onTogglePanel,
  onOpenSidebar,
}: {
  title: string;
  messages: Message[];
  details: Record<string, Detail>;
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenSidebar: () => void;
}) {
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
          {messages.map((m) => (
            <ChatMessage
              key={m.id}
              message={m}
              details={details}
              activeDetailId={activeDetailId}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </div>
      </ScrollArea>

      {/* 输入区 */}
      <div className="shrink-0 px-5 pb-4">
        <div className="mx-auto max-w-3xl">
          <div className="relative rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring">
            <Textarea
              rows={1}
              placeholder="给 Agent 发消息…"
              className="min-h-0 resize-none border-0 bg-transparent px-4 py-3.5 pr-14 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
            <Button
              size="icon-sm"
              aria-label="发送"
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
