"use client";

import { Plus, Search, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";

import type { ConversationListItem } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { ConversationItem } from "./conversation-item";
import { ThemeToggle } from "./theme-toggle";
import type { ThemeSetting } from "../_hooks/use-theme";

export type SidebarProps = {
  conversations: ConversationListItem[];
  isLoading: boolean;
  activeId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
  userEmail: string;
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
  onTogglePin,
  onDelete,
  userEmail,
  theme,
  onCycleTheme,
}: SidebarProps) {
  // 待确认删除的会话（确认弹窗由侧栏统一持有，菜单里点「Delete」只是发起确认）
  const [pendingDelete, setPendingDelete] =
    useState<ConversationListItem | null>(null);
  // 置顶的在前（后端已按置顶时刻排序），分两组展示
  const pinned = conversations.filter((c) => c.pinnedAt !== null);
  const recent = conversations.filter((c) => c.pinnedAt === null);
  const renderItem = (c: ConversationListItem) => (
    <ConversationItem
      key={c.id}
      conversation={c}
      active={c.id === activeId}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onRequestDelete={setPendingDelete}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：品牌 + 新建 */}
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <Link href="/" aria-label="Back to home" className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">AgentSpark</span>
        </Link>
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
          {pinned.length > 0 && (
            <>
              <SectionLabel>Pinned</SectionLabel>
              {pinned.map(renderItem)}
            </>
          )}
          <SectionLabel>Recent</SectionLabel>
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
            recent.map(renderItem)
          )}
        </div>
      </ScrollArea>

      {/* 底部：用户 + 主题切换 + 设置 */}
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2.5">
        <Link
          href="/settings/profile"
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md transition-colors hover:bg-accent/60"
        >
          <Avatar size="sm">
            <AvatarFallback>
              {userEmail.charAt(0).toUpperCase() || "U"}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium">{userEmail}</span>
        </Link>
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
        </div>
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* 标题可能是很长的无空格 URL：最多两行、任意处断行，避免撑破弹窗 */}
              <span className="line-clamp-2 break-all font-medium text-foreground">
                {pendingDelete?.goal.trim() || "New conversation"}
              </span>
              It will be removed from your list. If it is still running, it
              will be stopped first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {children}
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
