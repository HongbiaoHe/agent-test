"use client";

import {
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { useCanvas } from "../_hooks/use-canvas";
import { CanvasChat } from "./canvas-chat";
import { CanvasSidebar } from "./canvas-sidebar";
import { FlowCanvas } from "./flow-canvas";

export function CanvasShell({ sessionId }: { sessionId: string | null }) {
  // 收起完全走 CSS（内容保持挂载）：useCanvas 在本组件、CanvasChat 收起也不卸载，
  // socket 订阅与 agent 执行不受影响——"只是收起，不影响功能"。
  const c = useCanvas(sessionId);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  return (
    <div className="flex h-full w-full">
      {/* 左侧：画布列表 + 折叠把手 */}
      <div className="relative flex h-full shrink-0">
        <div
          className={cn(
            "h-full overflow-hidden transition-[width] duration-200",
            leftCollapsed ? "w-0" : "w-64",
          )}
        >
          <CanvasSidebar activeId={sessionId} />
        </div>
        <button
          type="button"
          onClick={() => setLeftCollapsed((v) => !v)}
          title={leftCollapsed ? "展开画布列表" : "收起画布列表"}
          aria-label={leftCollapsed ? "展开画布列表" : "收起画布列表"}
          className="absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 translate-x-full items-center justify-center rounded-r-md border border-l-0 border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          {leftCollapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>

      {sessionId ? (
        <>
          <div className="relative min-w-0 flex-1">
            <FlowCanvas
              canvas={c.canvas}
              readOnly={c.readOnly}
              onMoveNode={c.moveNode}
              onApplyOp={c.applyUserOp}
            />
          </div>

          {/* 右侧：对话栏 + 折叠把手。收起用 CSS（w-0），CanvasChat 始终挂载 → agent 继续执行不受影响 */}
          <div className="relative flex h-full shrink-0">
            <button
              type="button"
              onClick={() => setRightCollapsed((v) => !v)}
              title={rightCollapsed ? "展开对话" : "收起对话"}
              aria-label={rightCollapsed ? "展开对话" : "收起对话"}
              className="absolute top-1/2 left-0 z-20 flex size-6 -translate-x-full -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              {rightCollapsed ? (
                <PanelRightOpen className="size-4" />
              ) : (
                <PanelRightClose className="size-4" />
              )}
            </button>
            <div
              className={cn(
                "h-full overflow-hidden transition-[width] duration-200",
                rightCollapsed ? "w-0" : "w-96",
              )}
            >
              <div className="flex h-full w-96 flex-col border-l border-border bg-background">
                <CanvasChat
                  chat={c.chat}
                  tokens={c.tokens}
                  busy={c.busy}
                  sessionModel={c.model}
                  onSend={c.send}
                  onStop={c.stop}
                  onAnswer={c.answerAsk}
                  onResolve={c.resolveControl}
                />
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <LayoutGrid className="size-10 opacity-40" />
          <p className="text-sm">
            新建或选择一块画布，用一句话让 Agent 自动搭建工作流。
          </p>
        </div>
      )}
    </div>
  );
}
