"use client";

import {
  LayoutGrid,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

import { useCanvas } from "../_hooks/use-canvas";
import { useIsMobile } from "../_hooks/use-is-mobile";
import { usePanelCollapsed } from "../_hooks/use-panel-collapsed";
import { CanvasChat } from "./canvas-chat";
import { CanvasSidebar } from "./canvas-sidebar";
import { FlowCanvas } from "./flow-canvas";

export function CanvasShell({ sessionId }: { sessionId: string | null }) {
  // 收起完全走 CSS（内容保持挂载）：useCanvas 在本组件、CanvasChat 收起也不卸载，
  // socket 订阅与 agent 执行不受影响——"只是收起，不影响功能"。
  const c = useCanvas(sessionId);
  // 清空会话记录的二次确认弹窗
  const [confirmClear, setConfirmClear] = useState(false);
  const [leftCollapsed, toggleLeft] = usePanelCollapsed("left");
  const [rightCollapsed, toggleRight] = usePanelCollapsed("right");
  // < md 改成底部抽屉：两侧栏各占 64/96 宽，手机上画布基本没地方了
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  // 两块面板各只实例化一份：CanvasChat 里有输入草稿、模型选择与滚动位置，
  // 桌面栏与移动抽屉各挂一份会各存一套。桌面/手机两条分支互斥渲染，故不会重复挂载。
  const sidebar = (
    <CanvasSidebar
      activeId={sessionId}
      onNavigate={isMobile ? () => setListOpen(false) : undefined}
    />
  );
  const chat = (
    <CanvasChat
      sessionId={sessionId}
      chat={c.chat}
      tokens={c.tokens}
      busy={c.busy}
      sessionModel={c.model}
      sessionThinkingLevel={c.thinkingLevel}
      onSend={c.send}
      onStop={c.stop}
      onAnswer={c.answerAsk}
      onResolve={c.resolveControl}
      onClear={() => setConfirmClear(true)}
      clearing={c.clearing}
    />
  );

  return (
    <div className="flex h-full w-full flex-col md:flex-row">
      {/* 左侧：画布列表 + 折叠把手（手机上整块不渲染，改走底部抽屉） */}
      {!isMobile && (
        <div className="relative flex h-full shrink-0">
          {/* 宽度与图标方向由 <html data-canvas-left> 驱动（layout 的预水合脚本在首屏绘制前写好），
              不用 React state —— 否则 SSR 首帧总是展开态，读到缓存的"已收起"会闪一下再收起。 */}
          <div
            className={cn(
              "h-full w-64 overflow-hidden transition-[width] duration-200",
              "[html[data-canvas-left=collapsed]_&]:w-0",
            )}
          >
            {sidebar}
          </div>
          <button
            type="button"
            onClick={toggleLeft}
            title={leftCollapsed ? "Show canvas list" : "Hide canvas list"}
            aria-label={leftCollapsed ? "Show canvas list" : "Hide canvas list"}
            className="absolute top-1/2 right-0 z-20 flex size-6 -translate-y-1/2 translate-x-full items-center justify-center rounded-r-md border border-l-0 border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            <PanelLeftClose className="size-4 [html[data-canvas-left=collapsed]_&]:hidden" />
            <PanelLeftOpen className="hidden size-4 [html[data-canvas-left=collapsed]_&]:block" />
          </button>
        </div>
      )}

      {sessionId ? (
        <>
          <div className="relative min-w-0 flex-1">
            {/* key=sessionId：切画布重挂载 react-flow 实例（视口/选中态归零并重新 fitView）。
                否则视口停留在上一块画布的坐标，新画布节点在视野外 → 表现为"切换后空白" */}
            <FlowCanvas
              key={sessionId}
              canvas={c.canvas}
              readOnly={c.readOnly}
              onMoveNode={c.moveNode}
              onApplyOp={c.applyUserOp}
              saveStates={c.saveStates}
              onMarkSaving={c.markSaving}
              onCancelSaving={c.cancelSaving}
            />
          </div>

          {/* 右侧：对话栏 + 折叠把手。收起用 CSS（w-0），CanvasChat 始终挂载 → agent 继续执行不受影响 */}
          {!isMobile && (
            <div className="relative flex h-full shrink-0">
              <button
                type="button"
                onClick={toggleRight}
                title={rightCollapsed ? "Show chat" : "Hide chat"}
                aria-label={rightCollapsed ? "Show chat" : "Hide chat"}
                className="absolute top-1/2 left-0 z-20 flex size-6 -translate-x-full -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
              >
                <PanelRightClose className="size-4 [html[data-canvas-right=collapsed]_&]:hidden" />
                <PanelRightOpen className="hidden size-4 [html[data-canvas-right=collapsed]_&]:block" />
              </button>
              {/* 同左栏：宽度走 <html data-canvas-right>，避免首帧闪现 */}
              <div
                className={cn(
                  "h-full w-96 overflow-hidden transition-[width] duration-200",
                  "[html[data-canvas-right=collapsed]_&]:w-0",
                )}
              >
                <div className="flex h-full w-96 flex-col border-l border-border bg-background">
                  {chat}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        /* 空态：px-6 + max-w 是必须的——没有它，这句话在 375px 屏上会顶到左右边缘。
           手机上再给一个入口按钮，否则用户得自己发现底部那条 Canvases。 */
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <LayoutGrid className="size-6" />
          </span>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              No canvas selected
            </p>
            <p className="max-w-xs text-pretty text-sm text-muted-foreground">
              Pick one from the list or create a new one, then describe the
              workflow in one sentence.
            </p>
          </div>
          {isMobile && (
            <Button variant="outline" onClick={() => setListOpen(true)}>
              <LayoutGrid className="size-4" /> Browse canvases
            </Button>
          )}
        </div>
      )}

      {/* 手机：底部固定条（拇指可达）+ 两个从下往上弹的抽屉。
          抽屉关闭时内容不挂载，但 socket 与 agent 都在 useCanvas（本组件）里，不受影响；
          代价只是关掉对话后输入框草稿不留存。 */}
      {isMobile && (
        <>
          <nav className="flex shrink-0 items-center gap-1 border-t border-border bg-background px-2 py-1.5">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => setListOpen(true)}
            >
              <LayoutGrid className="size-4" /> Canvases
            </Button>
            <span className="h-5 w-px bg-border" aria-hidden />
            <Button
              variant="ghost"
              className="flex-1"
              disabled={!sessionId}
              onClick={() => setChatOpen(true)}
            >
              <MessagesSquare className="size-4" /> Chat
            </Button>
          </nav>

          <Drawer open={listOpen} onOpenChange={setListOpen} showSwipeHandle>
            {/* --drawer-height 是 DrawerContent 的尺寸入口（默认 auto + max 100dvh-6rem） */}
            <DrawerContent className="[--drawer-height:70dvh]">
              <DrawerHeader className="sr-only">
                <DrawerTitle>Canvas list</DrawerTitle>
              </DrawerHeader>
              <div className="min-h-0 flex-1 overflow-hidden">{sidebar}</div>
            </DrawerContent>
          </Drawer>

          <Drawer open={chatOpen} onOpenChange={setChatOpen} showSwipeHandle>
            <DrawerContent className="[--drawer-height:88dvh]">
              <DrawerHeader className="sr-only">
                <DrawerTitle>Chat</DrawerTitle>
              </DrawerHeader>
              <div className="flex min-h-0 flex-1 flex-col">{chat}</div>
            </DrawerContent>
          </Drawer>
        </>
      )}

      {/* 清空会话记录二次确认：清对话与 agent 上下文，画布节点与 token 统计保留 */}
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear chat history?</DialogTitle>
            <DialogDescription>
              This deletes every message in this canvas and resets the agent&apos;s
              context, so the next run starts from scratch. Nodes, edges, and the
              token total stay. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={c.clearing}
              onClick={() => {
                setConfirmClear(false);
                void c.clearMessages();
              }}
            >
              Clear history
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
