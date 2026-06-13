"use client";

import { Plus, Search, Sparkles } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { Conversation } from "../_data/mock";
import { ThemeToggle } from "./theme-toggle";

type SidebarProps = {
  conversations: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
};

/** 侧边栏内容主体，desktop 的 <aside> 与 mobile 的 Sheet 抽屉共用。 */
export function SidebarContent({
  conversations,
  activeId,
  onSelect,
  theme,
  onToggleTheme,
}: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：品牌 + 新建 */}
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">AgentSpark</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="新建对话" />
            }
          >
            <Plus />
          </TooltipTrigger>
          <TooltipContent>新建对话</TooltipContent>
        </Tooltip>
      </div>

      {/* 搜索 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="搜索对话…" className="h-8 pl-8" />
        </div>
      </div>

      {/* 会话列表 */}
      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="flex flex-col gap-0.5 py-1">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            最近
          </div>
          {conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground/80 hover:bg-accent/60",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {c.title}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {c.updatedLabel}
                  </span>
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {c.preview}
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      {/* 底部：用户 + 主题切换 */}
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>简</AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">简博</span>
        </div>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>
    </div>
  );
}

/** Desktop 常驻侧边栏（≥lg 显示）。 */
export function ConversationSidebar(props: SidebarProps) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col border-r bg-muted/30 lg:flex">
      <SidebarContent {...props} />
    </aside>
  );
}
