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
      // 位移用 transform 而不是 left/right：后者每帧都要重新布局+重绘（还带着按钮的阴影），
      // 且与面板的合成层动画不同步——按钮会"拖在面板后面"。translate 走合成层，
      // 时长与曲线取自 .floating-panel 的同一组变量（见 globals.css），两者同起同落。
      style={{
        [side]: 0,
        transform: `translate(${side === "right" ? -inset : inset}px, -50%)`,
      }}
      className={cn(
        "floating-panel-rail pointer-events-none absolute top-1/2 z-20 flex flex-col gap-2",
        "motion-reduce:transition-none",
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
              // 不透明底、不做 backdrop-blur：竖轨滑动时按钮每帧都在新位置，模糊得逐帧重采样
              // 底下的画布（同 .floating-panel 当年去掉 backdrop-filter 的理由）
              "border border-border bg-card text-muted-foreground shadow-lg",
              "floating-panel-rail__trigger hover:bg-accent hover:text-foreground",
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
