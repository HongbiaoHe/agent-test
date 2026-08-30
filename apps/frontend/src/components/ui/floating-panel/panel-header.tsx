"use client";

import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 面板标题栏：图标 + 标题 + 右侧操作区。
 * FloatingPanel 内部用它，手机端的抽屉也复用同一条，桌面/手机两处标题栏才不会走形。
 */
export function PanelHeader({
  icon,
  title,
  actions,
  className,
  ...rest
}: {
  icon?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
} & Omit<ComponentProps<"div">, "title">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2",
        className,
      )}
      {...rest}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        <span className="truncate">{title}</span>
      </span>
      {actions && (
        <span className="flex shrink-0 items-center gap-1">{actions}</span>
      )}
    </div>
  );
}
