"use client";

import { AlertCircle, Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { SaveState } from "../_hooks/use-canvas";

/**
 * 节点内容保存指示：聚合全部节点的 update_node 状态，统一显示一处（不在每个节点上）。
 *
 * 只输出「图标 + 一句话 + 语义色」，容器样式交给调用方。它不是常驻信息——没有任何节点
 * 在保存时返回 null，因此调用方把它当成一枚会自己来去的独立胶囊，而不是塞进常驻的岛里。
 */
export function CanvasSaveStatus({
  saveStates,
  className,
}: {
  saveStates: Record<string, SaveState>;
  className?: string;
}) {
  const values = Object.values(saveStates);
  const state: SaveState | null = values.includes("saving")
    ? "saving"
    : values.includes("error")
      ? "error"
      : values.includes("saved")
        ? "saved"
        : null;
  if (!state) return null;

  const view = {
    saving: {
      icon: <Loader2 className="size-3.5 animate-spin" />,
      text: "Saving…",
      tone: "text-muted-foreground",
    },
    saved: {
      icon: <Check className="size-3.5" />,
      text: "Saved",
      tone: "text-success",
    },
    error: {
      icon: <AlertCircle className="size-3.5" />,
      text: "Save failed, reloaded",
      tone: "text-destructive",
    },
  }[state];

  return (
    <div
      className={cn("flex items-center gap-1.5 text-xs", view.tone, className)}
      role="status"
      aria-live="polite"
    >
      {view.icon}
      {/* 小屏位置紧张：文字视觉隐藏但保留在无障碍树里，图标+语义色已足够表意 */}
      <span className="font-medium max-md:sr-only">{view.text}</span>
    </div>
  );
}
