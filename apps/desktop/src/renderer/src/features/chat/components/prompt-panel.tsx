"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 通用交互面板：固定在输入框上方，承载需要用户响应的交互
 * （审批、数据输入、向用户提问等都用这个壳）。
 * 纯展示外壳：icon + 标题 + 内容区（超高内滚）+ 底部操作区，业务状态由调用方管理。
 * 样式语言与 TaskPlanPanel 一致。
 */
export function PromptPanel({
  icon: Icon,
  title,
  children,
  footer,
  className,
  glow = false,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** 待处理高光边框：一道光沿边框旋转，吸引用户注意需响应的内容 */
  glow?: boolean;
}) {
  return (
    <div
      className={cn(
        // glow 时旋转高光环（GlowBorder 同款 .glow-border）即边框，不再叠加静态 border
        "mb-2 overflow-hidden rounded-xl bg-card shadow-sm",
        glow ? "glow-border" : "border",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium">
        <Icon className="size-3.5 shrink-0 text-primary" />
        <span>{title}</span>
      </div>
      <div className="max-h-72 overflow-y-auto border-t px-3 py-2.5">
        {children}
      </div>
      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
          {footer}
        </div>
      )}
    </div>
  );
}
