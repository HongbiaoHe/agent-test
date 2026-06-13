"use client";

import { LogOut, Plus, Search, Settings, Sparkles } from "lucide-react";
import Link from "next/link";

import type { ConversationListItem } from "@/lib/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { ThemeToggle } from "./theme-toggle";
import type { ThemeSetting } from "../_hooks/use-theme";

const STATUS_BADGE: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  idle: { label: "New", variant: "outline" },
  queued: { label: "Queued", variant: "secondary" },
  running: { label: "Running", variant: "secondary" },
  waiting_approval: { label: "Awaiting approval", variant: "default" },
  done: { label: "Done", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
  stopped: { label: "Stopped", variant: "outline" },
};

export type SidebarProps = {
  conversations: ConversationListItem[];
  isLoading: boolean;
  activeId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  userEmail: string;
  onSignOut: () => void;
  theme?: ThemeSetting;
  onCycleTheme: () => void;
};

/** 侧边栏内容主体，desktop 的 <aside> 与 mobile 的 Sheet 抽屉共用。 */
export function SidebarContent({
  conversations,
  isLoading,
  activeId,
  query,
  onQueryChange,
  onSelect,
  onNewChat,
  userEmail,
  onSignOut,
  theme,
  onCycleTheme,
}: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：品牌 + 新建 */}
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Agent</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New conversation"
                onClick={onNewChat}
              />
            }
          >
            <Plus />
          </TooltipTrigger>
          <TooltipContent>New conversation</TooltipContent>
        </Tooltip>
      </div>

      {/* 搜索 */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search conversations…"
            className="h-8 pl-8"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
      </div>

      {/* 会话列表 */}
      <ScrollArea className="min-h-0 flex-1 px-2">
        <div className="flex flex-col gap-0.5 py-1">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Recent
          </div>
          {isLoading ? (
            <div className="space-y-2 px-2.5 py-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
              No conversations yet — tap + in the top right to start
            </p>
          ) : (
            conversations.map((c) => {
              const active = c.id === activeId;
              const badge = STATUS_BADGE[c.status];
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground/80 hover:bg-accent/60",
                  )}
                >
                  <span className="truncate text-sm font-medium">
                    {c.goal.trim() || "New conversation"}
                  </span>
                  {badge && (
                    <Badge variant={badge.variant} className="w-fit">
                      {badge.label}
                    </Badge>
                  )}
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* 底部：用户 + 主题切换 + 退出 */}
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>
              {userEmail.charAt(0).toUpperCase() || "U"}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">{userEmail}</span>
        </div>
        <div className="flex shrink-0 items-center">
          <ThemeToggle theme={theme} onCycle={onCycleTheme} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Settings"
                  nativeButton={false}
                  render={<Link href="/settings" />}
                />
              }
            >
              <Settings />
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Sign out"
                  onClick={onSignOut}
                />
              }
            >
              <LogOut />
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
        </div>
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
