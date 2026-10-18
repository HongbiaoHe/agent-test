"use client";

import { MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import type { ConversationListItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { conversationTitle } from "../_lib/conversation-title";

/** 与后端 UpdateConversationDto.title 的上限一致 */
const TITLE_MAX = 200;

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
 * 侧栏的一条会话：整行可点进入；右侧「更多」菜单提供重命名 / 置顶 / 删除。
 * 菜单按钮与行按钮是兄弟节点（按钮不能嵌套按钮）；桌面端悬停 / 聚焦 / 菜单打开时才显示，
 * 触屏没有悬停，始终显示。
 * 重命名是行内编辑：Enter 或失焦保存，Esc 取消；清空保存 = 恢复显示首条消息。
 */
export function ConversationItem({
  conversation,
  active,
  onSelect,
  onTogglePin,
  onRename,
  onRequestDelete,
}: {
  conversation: ConversationListItem;
  active: boolean;
  onSelect: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onRequestDelete: (conversation: ConversationListItem) => void;
}) {
  const pinned = conversation.pinnedAt !== null;
  const badge = STATUS_BADGE[conversation.status];
  const title = conversationTitle(conversation);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // 点了 Rename、等菜单关完再进编辑（见 DropdownMenu 的 onOpenChangeComplete）
  const renameRequested = useRef(false);

  function startRename() {
    renameRequested.current = false;
    // 默认值：已有自定义标题用它，否则用当前显示的名字（首条消息）方便在原话上改
    setDraft(title);
    setEditing(true);
  }

  function commit() {
    if (!editing) return;
    setEditing(false);
    const next = draft.trim();
    // 没改动不发请求（含「本来就没自定义标题、原样回车」）
    if (next === (conversation.title?.trim() ?? title)) return;
    onRename(conversation.id, next);
  }

  if (editing) {
    return (
      <div className="px-1 py-1">
        <Input
          aria-label="Conversation name"
          value={draft}
          maxLength={TITLE_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            // 输入法组词中的回车是选词，不是提交
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          autoFocus
          // 移动端必须 ≥16px（text-base）：iOS 对 <16px 的输入框聚焦会自动放大整页
          className="h-8 text-base md:text-sm"
        />
      </div>
    );
  }

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
          <span className="truncate text-sm font-medium">{title}</span>
        </span>
        {badge && (
          <Badge variant={badge.variant} className="w-fit">
            {badge.label}
          </Badge>
        )}
      </button>
      {/* 进编辑要等菜单完全关闭：点 Rename 时若立刻把这一行换成输入框，菜单随之卸载，
          关闭时的焦点恢复（在抽屉这种模态 Dialog 里还叠着它自己的焦点管理）会把焦点从刚出现的
          输入框上抢走 → 失焦即保存 → 编辑框一闪就没了（窄屏抽屉里实测必现）。 */}
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (!open && renameRequested.current) startRename();
        }}
      >
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
            onClick={() => {
              renameRequested.current = true;
            }}
          >
            <Pencil />
            Rename
          </DropdownMenuItem>
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
