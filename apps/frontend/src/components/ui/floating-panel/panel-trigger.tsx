"use client";

import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { DockSide } from "./types";

/**
 * 触发按钮的承载轨：贴画布某一侧垂直居中，按钮在里面竖着排。
 * `inset` 由调用方按该侧被停靠面板占掉的宽度给，免得整条轨被压在面板底下。
 */
export function PanelTriggerRail({
  side,
  inset,
  children,
}: {
  side: DockSide;
  /** 离画布该侧边缘的距离（px）。 */
  inset: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{ [side]: inset }}
      className={cn(
        "pointer-events-none absolute top-1/2 z-20 flex -translate-y-1/2 flex-col gap-2",
        // 位置变化也走过渡：面板停靠/收起时整条轨平滑挪位，不是瞬移
        "transition-[left,right] duration-200 ease-out motion-reduce:transition-none",
      )}
    >
      {children}
    </div>
  );
}

/**
 * 画布边缘的悬浮触发按钮（44×44）。面板展开时朝边缘滑走并让出点击，
 * 但**保留占位**——同一条轨上还有别的按钮，抽掉会让它们跟着移位。
 */
export function PanelTrigger({
  side,
  icon,
  label,
  tooltip,
  open,
  onClick,
}: {
  /** 所在的画布侧边：决定滑出方向与 tooltip 弹出方向。 */
  side: DockSide;
  icon: ReactNode;
  /** 无障碍名（稳定不变）。tooltip 省略时也用它当提示文案。 */
  label: string;
  /** tooltip 文案。与 label 分开，是为了让提示可以随状态变而读屏名保持稳定。 */
  tooltip?: ReactNode;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            data-open={open}
            onClick={onClick}
            className={cn(
              "pointer-events-auto flex size-11 items-center justify-center rounded-full",
              "border border-border bg-card/85 text-muted-foreground shadow-lg backdrop-blur-md",
              "transition-all duration-200 ease-out hover:bg-accent hover:text-foreground",
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              "data-[open=true]:pointer-events-none data-[open=true]:opacity-0",
              "motion-reduce:transition-none",
              side === "left"
                ? "data-[open=true]:-translate-x-3"
                : "data-[open=true]:translate-x-3",
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent side={side === "left" ? "right" : "left"}>
        {tooltip ?? label}
      </TooltipContent>
    </Tooltip>
  );
}
