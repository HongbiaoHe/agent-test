"use client";

import { GripHorizontal, Pin, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { PanelHeader } from "./panel-header";
import { ResizeHandles } from "./resize-handles";
import type { FloatingPanelApi } from "./use-floating-panel";

/**
 * 悬浮面板外壳：贴边停靠 / 自由浮动、拖动、缩放、靠边吸附、钉住。
 * 位置与手势状态全在 `useFloatingPanel` 里，本组件只负责外观与标题栏控件。
 *
 * **关闭不卸载**：收起走 visibility + opacity，children 始终挂载——画布对话面板里有输入
 * 草稿、滚动位置与运行中的 agent 流，卸载会一并丢掉。
 */
export function FloatingPanel({
  panel,
  open,
  icon,
  title,
  actions,
  pinned,
  onPinnedChange,
  onClose,
  className,
  children,
}: {
  panel: FloatingPanelApi;
  open: boolean;
  icon?: ReactNode;
  title: string;
  /** 标题栏右侧的业务操作（token 徽标、清空历史等）。 */
  actions?: ReactNode;
  /** 传了才渲染图钉；钉住后点画布不收起。 */
  pinned?: boolean;
  onPinnedChange?: (next: boolean) => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  // 整体解构再用：`ref={panel.setPanelEl}` 这种成员表达式会让 react-hooks/refs
  // 把整个 panel 对象判成 ref，之后每次 panel.x 都会报「渲染期访问 ref」
  const {
    placement,
    interacting,
    snapPreviewStyle,
    setPanelEl,
    style,
    dragHandleProps,
    resizeDirs,
    getResizeHandleProps,
  } = panel;
  const draggable = !!dragHandleProps.onPointerDown;
  // 收起时朝停靠的那条边滑出去；浮动态没有"哪条边"，只缩放淡出
  const exitShift =
    placement.mode === "dock"
      ? placement.side === "left"
        ? "data-[open=false]:-translate-x-3"
        : "data-[open=false]:translate-x-3"
      : "";

  return (
    <>
      {/* 吸附落点预览：拖到画布左右边缘时提示松手后会停到哪 */}
      {snapPreviewStyle && (
        <div
          aria-hidden
          style={snapPreviewStyle}
          className="pointer-events-none absolute z-20 rounded-xl border-2 border-dashed border-primary/50 bg-primary/5"
        />
      )}

      <div
        ref={setPanelEl}
        style={style}
        data-open={open}
        role="complementary"
        aria-label={title}
        className={cn(
          // 最外层不裁切：缩放把手要跨出边界一点才好抓
          // .floating-panel 管进出场过渡（见 globals.css，那里说明了为什么不过渡几何属性）
          "floating-panel pointer-events-auto absolute z-30",
          "data-[open=false]:pointer-events-none data-[open=false]:scale-[0.98]",
          interacting && "select-none",
          exitShift,
          className,
        )}
      >
        <div
          className={cn(
            "flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl",
            interacting && "ring-2 ring-ring/40",
          )}
        >
          <PanelHeader
            icon={icon}
            title={title}
            className={cn(
              "bg-card/60",
              draggable && "cursor-grab touch-none active:cursor-grabbing",
            )}
            {...dragHandleProps}
            actions={
              <>
                {actions}
                {onPinnedChange && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={pinned ? "Unpin panel" : "Pin panel"}
                    aria-pressed={pinned}
                    title={
                      pinned
                        ? "Pinned — clicking the canvas keeps this open"
                        : "Pin so clicking the canvas doesn't close this"
                    }
                    onClick={() => onPinnedChange(!pinned)}
                  >
                    <Pin className={cn(pinned && "fill-current text-primary")} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Close ${title}`}
                  title="Close"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </>
            }
          />
          {/* min-h-0：让内部 ScrollArea 能收缩并自己滚，而不是把面板撑破 */}
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>

        {/* 拖动把手的视觉暗示：标题栏左侧那三条横杠只在可拖时出现 */}
        {draggable && (
          <GripHorizontal
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1 size-3.5 -translate-x-1/2 text-muted-foreground/40"
          />
        )}

        <ResizeHandles dirs={resizeDirs} getHandleProps={getResizeHandleProps} />
      </div>
    </>
  );
}
