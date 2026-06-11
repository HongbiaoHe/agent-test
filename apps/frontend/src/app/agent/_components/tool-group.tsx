"use client";

import { ChevronDown, Loader, Wrench } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { ToolChip, type ToolItem } from "./tool-chip";

/**
 * 连续工具调用的聚合块：≥2 个折叠成一个可展开块（默认收起，概述行按顺序逐条列出工具名，
 * 运行中显示转圈 + 「调用中」）；单个工具直接渲染原 chip、不套折叠壳。
 * 展开后每个工具仍可点击打开右侧详情面板。
 */
export function ToolGroup({
  tools,
  activeDetailId,
  onOpenDetail,
}: {
  tools: ToolItem[];
  activeDetailId: string | null;
  onOpenDetail: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (tools.length === 1) {
    const t = tools[0];
    return (
      <div>
        <ToolChip
          item={t}
          active={activeDetailId === t.id}
          onOpenDetail={onOpenDetail}
        />
      </div>
    );
  }

  const running = tools.some((t) => !t.done);
  const names = tools.map((t) => t.name).join(" · ");

  return (
    <div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {running ? (
            <Loader className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={names}
          >
            {names}
          </span>
          <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground uppercase">
            {running ? "调用中" : `${tools.length} 个`}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
        </button>
        {open && (
          <div className="flex flex-col items-start gap-1.5 border-t px-2.5 py-2">
            {tools.map((t) => (
              <ToolChip
                key={t.id}
                item={t}
                active={activeDetailId === t.id}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
