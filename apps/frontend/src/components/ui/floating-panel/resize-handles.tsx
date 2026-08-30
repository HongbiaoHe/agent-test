"use client";

import type { PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

import type { ResizeDir } from "./types";

/**
 * 把手命中区。边把手做成跨过面板边界的 8px 条（外 2px / 内 6px），比纯内侧好抓；
 * 因此 FloatingPanel 的最外层不能开 overflow-hidden，圆角裁切放在里面那层。
 */
const HANDLE: Record<ResizeDir, string> = {
  n: "left-3 right-3 -top-0.5 h-2 cursor-ns-resize",
  s: "left-3 right-3 -bottom-0.5 h-2 cursor-ns-resize",
  e: "top-3 bottom-3 -right-0.5 w-2 cursor-ew-resize",
  w: "top-3 bottom-3 -left-0.5 w-2 cursor-ew-resize",
  ne: "-top-0.5 -right-0.5 size-3.5 cursor-nesw-resize",
  nw: "-top-0.5 -left-0.5 size-3.5 cursor-nwse-resize",
  se: "-bottom-0.5 -right-0.5 size-3.5 cursor-nwse-resize",
  sw: "-bottom-0.5 -left-0.5 size-3.5 cursor-nesw-resize",
};

/** 边把手上那条 hover 才显形的指示线（角把手不画，避免四角出现小十字）。 */
const GRIP: Partial<Record<ResizeDir, string>> = {
  n: "inset-x-6 top-1/2 h-0.5 -translate-y-1/2",
  s: "inset-x-6 top-1/2 h-0.5 -translate-y-1/2",
  e: "inset-y-6 left-1/2 w-0.5 -translate-x-1/2",
  w: "inset-y-6 left-1/2 w-0.5 -translate-x-1/2",
};

export function ResizeHandles({
  dirs,
  getHandleProps,
}: {
  dirs: ResizeDir[];
  getHandleProps: (dir: ResizeDir) => {
    onPointerDown: (e: ReactPointerEvent) => void;
  };
}) {
  return (
    <>
      {dirs.map((dir) => (
        <div
          key={dir}
          aria-hidden
          className={cn("group/handle absolute z-10 touch-none", HANDLE[dir])}
          {...getHandleProps(dir)}
        >
          {GRIP[dir] && (
            <span
              className={cn(
                "absolute rounded-full bg-primary/50 opacity-0 transition-opacity duration-150 group-hover/handle:opacity-100 motion-reduce:transition-none",
                GRIP[dir],
              )}
            />
          )}
        </div>
      ))}
    </>
  );
}
