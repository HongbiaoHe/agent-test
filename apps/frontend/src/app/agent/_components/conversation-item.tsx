"use client";

import { MoreHorizontal, Pin, PinOff, Trash2 } from "lucide-react";

import type { ConversationListItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

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

/**
 * 侧栏的一条会话：整行可点进入；右侧「更多」菜单提供置顶 / 删除。
 * 菜单按钮与行按钮是兄弟节点（按钮不能嵌套按钮）；桌面端悬停 / 聚焦 / 菜单打开时才显示，
 * 触屏没有悬停，始终显示。
 */
export function ConversationItem({
  conversation,
  active,
  onSelect,
  onTogglePin,
  onRequestDelete,
}: {
  conversation: ConversationListItem;
  active: boolean;
  onSelect: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onRequestDelete: (conversation: ConversationListItem) => void;
}) {
  const pinned = conversation.pinnedAt !== null;
  const badge = STATUS_BADGE[conversation.status];
  return (
    <div className="group/item relative">
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        className={cn(
          "flex w-full cursor-pointer flex-col gap-1 rounded-lg py-2 pr-9 pl-2.5 text-left transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-foreground/80 hover:bg-accent/60",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {pinned && (
            <Pin
              aria-label="Pinned"
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
          <span className="truncate text-sm font-medium">
            {conversation.goal.trim() || "New conversation"}
          </span>
        </span>
        {badge && (
          <Badge variant={badge.variant} className="w-fit">
            {badge.label}
          </Badge>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Conversation actions"
              className="absolute top-1.5 right-1.5 text-muted-foreground lg:opacity-0 lg:group-hover/item:opacity-100 lg:focus-visible:opacity-100 lg:data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={() => onTogglePin(conversation.id, !pinned)}
          >
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onRequestDelete(conversation)}
          >
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
