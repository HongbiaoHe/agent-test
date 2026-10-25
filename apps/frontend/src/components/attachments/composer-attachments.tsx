"use client";

import { AlertTriangle, Film, Loader2, Music, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { DraftAttachment } from "./use-attachments";

/**
 * 输入框上方的附件条：每枚一个方块（图片显示缩略图，视频 / 音频显示类型图标），
 * 上传中盖一层进度，失败标红，右上角可移除。指上去浮出文件名与状态。
 */
export function ComposerAttachments({
  items,
  onRemove,
  className,
}: {
  items: DraftAttachment[];
  onRemove: (localId: string) => void;
  /** 各输入框的内边距不同，留给调用方覆盖 */
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Attachments"
      className={cn("flex flex-wrap gap-2 px-3 pt-3", className)}
    >
      {items.map((it) => (
        <li key={it.localId} className="relative">
          <Tooltip>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    "relative flex size-14 items-center justify-center overflow-hidden rounded-lg border bg-muted",
                    it.status === "error" && "border-destructive",
                  )}
                />
              }
            >
              <Thumb item={it} />
              {it.status === "uploading" && (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-background/70 text-[10px] font-medium tabular-nums text-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {Math.round(it.progress * 100)}%
                </span>
              )}
              {it.status === "error" && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/70 text-destructive">
                  <AlertTriangle className="size-4" />
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <span className="block truncate">{it.file.name}</span>
              {it.status === "error" && (
                <span className="block text-background/80">{it.error}</span>
              )}
            </TooltipContent>
          </Tooltip>
          <Button
            variant="secondary"
            size="icon-xs"
            aria-label={`Remove ${it.file.name}`}
            onClick={() => onRemove(it.localId)}
            className="absolute -top-1.5 -right-1.5 size-5 rounded-full border shadow-sm"
          >
            <X className="size-3" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Thumb({ item }: { item: DraftAttachment }) {
  if (item.type === "image") {
    return (
      // 本地 object URL 预览，不走 next/image（无需优化，也不是远程地址）
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.previewUrl}
        alt={item.file.name}
        className="size-full object-cover"
      />
    );
  }
  const Icon = item.type === "video" ? Film : Music;
  return <Icon className="size-5 text-muted-foreground" />;
}
