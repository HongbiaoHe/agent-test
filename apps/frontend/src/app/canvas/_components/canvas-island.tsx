"use client";

import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 画布悬浮控件的统一外观：圆角胶囊 + card 底 + 细边 + 投影 + 毛玻璃。
 *
 * 画布上所有浮在内容之上的东西都用这一套——顶部的返回/主题、底部的缩放、右侧的面板入口。
 * 宽度一律由内容撑开（不铺满画布宽度），这样它们读起来是「浮在画布上的几座小岛」，
 * 而不是把画布切开的横幅。react-flow 的 <Panel> 不接受组件包裹，所以样式单独导出成常量。
 */
export const CANVAS_ISLAND_CLASS =
  "flex items-center gap-0.5 rounded-full border border-border bg-card/85 p-1 shadow-lg backdrop-blur-md";

export function CanvasIsland({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("pointer-events-auto", CANVAS_ISLAND_CLASS, className)}>
      {children}
    </div>
  );
}

/** 岛内圆形图标键。手机上放大到 44 满足触摸目标下限（Apple HIG 44pt / Material 48dp）。 */
export function CanvasIslandButton({
  icon,
  label,
  tooltipSide = "bottom",
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground max-md:size-11",
              "transition-colors duration-200 hover:bg-accent hover:text-foreground",
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              "motion-reduce:transition-none",
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** 岛内分隔线：把功能分组切开（如缩放键与视图复位键）。 */
export function CanvasIslandDivider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />;
}
