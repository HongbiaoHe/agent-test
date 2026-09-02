"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * 画布上浮动工具条的统一形态。
 *
 * 此前节点 hover 出的操作组与选区工具条各写各的：一个是反色实心药丸配半透明图标，一个是
 * popover 描边药丸配 hover 变底；尺寸(6 vs 7)、hover 表现、tooltip（title 属性 vs 没有）、
 * 禁用态（压根没有）全不一致。两者停在同一个位置、做同一类事，长成两副样子只会让人以为
 * 它们不是一回事。统一到这里：一套药丸、一套按钮、一套 tooltip 与禁用表现。
 *
 * 视觉基准取选区工具条那一套（描边 popover 药丸）——它落在画布留白上，与卡片同属一套
 * 明暗语言；反色实心是为了压在媒体主视觉上才需要的，而这两条工具条都浮在卡片**外面**。
 */

/** 药丸容器：一排操作外面那层。 */
export function CanvasToolbar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // nodrag/nowheel：按在工具条上不拖动画布、不缩放
    <div
      className={cn(
        "nodrag nowheel flex items-center gap-0.5 rounded-full border border-border bg-popover p-1 text-popover-foreground shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 组间分隔：如「看图类 / 改结构类」之间划一道，误点的代价不同就该分开。 */
export function CanvasToolbarSeparator() {
  return <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />;
}

/** 计数标记（选中了几个）。 */
export function CanvasToolbarCount({ value }: { value: number }) {
  return (
    <span className="px-1 font-mono text-[10px] text-muted-foreground">
      {value}
    </span>
  );
}

/**
 * 禁用态用 aria-disabled 而不是 disabled 属性：原生 disabled 的元素收不到指针事件，
 * tooltip 就跟着哑掉——而「为什么不能按」恰恰是这时候最该说清楚的一句话。
 */
function disabledProps(disabled: boolean | undefined) {
  return {
    "aria-disabled": disabled || undefined,
    className: disabled ? "cursor-not-allowed opacity-50" : "",
  };
}

const FOCUS_RING =
  "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** 图标按钮。label 同时用作 tooltip 文案与读屏名字，两者不会再各说各话。 */
export function CanvasToolbarButton({
  label,
  icon,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** 破坏性操作：hover 才转红，常态不喧哗 */
  danger?: boolean;
  /** 禁用：变淡且不可按，tooltip 仍然出（用 aria-disabled，见 disabledProps） */
  disabled?: boolean;
}) {
  const d = disabledProps(disabled);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-disabled={d["aria-disabled"]}
            onClick={(e) => {
              // stopPropagation：按操作键不连带选中节点（否则每点一下都会弹出编辑面板）
              e.stopPropagation();
              if (disabled) return;
              onClick();
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors",
              FOCUS_RING,
              !disabled &&
                (danger
                  ? "hover:bg-accent hover:text-destructive"
                  : "hover:bg-accent hover:text-foreground"),
              d.className,
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 带文字的主操作（如「Add to chat」）：一条工具条最多一个，放最左。
 * active 表示这件事已经生效（如已圈进对话），按下去是撤销。
 */
export function CanvasToolbarAction({
  label,
  icon,
  onClick,
  active,
  disabled,
  tooltip,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** 补一句为什么/会发生什么；不给就不出 tooltip（文字已经写在按钮上了） */
  tooltip?: string;
}) {
  const d = disabledProps(disabled);
  const button = (
    <button
      type="button"
      aria-disabled={d["aria-disabled"]}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick();
      }}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
        FOCUS_RING,
        active
          ? "bg-primary text-primary-foreground"
          : !disabled && "hover:bg-accent hover:text-accent-foreground",
        d.className,
      )}
    >
      {icon}
      {label}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
