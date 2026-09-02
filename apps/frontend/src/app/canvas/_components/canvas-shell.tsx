"use client";

import { LayoutGrid, MessagesSquare } from "lucide-react";
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
import {
  FloatingPanel,
  PanelHeader,
  PanelTrigger,
  PanelTriggerRail,
} from "@/components/ui/floating-panel";

import { useAgentPhaseUi } from "../_hooks/use-agent-phase-ui";
import { useCanvas } from "../_hooks/use-canvas";
import { useCanvasPanels } from "../_hooks/use-canvas-panels";
import { useIsMobile } from "../_hooks/use-is-mobile";
import { CanvasBoot } from "./canvas-boot";
import { CanvasChat } from "./canvas-chat";
import { CanvasGallery } from "./canvas-gallery";
import { CanvasHeader } from "./canvas-header";
import { CanvasSidebar } from "./canvas-sidebar";
import { ChatHeaderActions } from "./chat-header-actions";
import { FlowCanvas } from "./flow-canvas";
import { ThinkingGrid } from "./thinking-indicator";

export function CanvasShell({ sessionId }: { sessionId: string | null }) {
  // 收起完全走 CSS（内容保持挂载）：useCanvas 在本组件、CanvasChat 收起也不卸载，
  // socket 订阅与 agent 执行不受影响——"只是收起，不影响功能"。
  const c = useCanvas(sessionId);
  // 清空会话记录的二次确认弹窗
  const [confirmClear, setConfirmClear] = useState(false);
  // 悬浮面板的定位基准：画布区域本身。面板绝对定位在它里面，不再占布局宽度。
  // 存元素而不是 ref：桌面/手机分支互斥渲染，这个容器会整个换掉，
  // 用 state 才能让面板的 ResizeObserver 跟着换到新节点上（否则会一直量旧节点的 0×0）
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null);
  const panels = useCanvasPanels(bounds);
  // < md 改成底部抽屉：面板即便悬浮也会盖掉手机上本就不多的画布
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // 对话入口按钮的执行态：面板收起 / 抽屉关着时，agent 在干什么只能从入口透出来
  const agentUi = useAgentPhaseUi(c.chat.items, c.busy);

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
      chat={c.chat}
      busy={c.busy}
      sessionModel={c.model}
      sessionThinkingLevel={c.thinkingLevel}
      onSend={c.send}
      onStop={c.stop}
      onAnswer={c.answerAsk}
      onResolve={c.resolveControl}
      onClearPlan={c.clearPlan}
      focusCount={c.focusNodeIds.length}
      onClearFocus={() => c.setFocus([])}
    />
  );
  const chatActions = (
    <ChatHeaderActions
      sessionId={sessionId}
      tokens={c.tokens}
      busy={c.busy}
      clearing={c.clearing}
      onClear={() => setConfirmClear(true)}
    />
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* 画布铺满：两块面板改为悬浮在它之上，不再从两侧挤压 */}
      <div className="relative min-h-0 min-w-0 flex-1">
        {sessionId ? (
          <>
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
            onPaneClick={isMobile ? undefined : panels.dismissUnpinned}
            onRetryMedia={c.retryMedia}
            onMergeVideo={c.mergeVideo}
            loading={c.isLoading}
            focusNodeIds={c.focusNodeIds}
            onSetFocus={c.setFocus}
            onAddConnectedNode={(input) => void c.addConnectedNode(input)}
          />
          {/* 顶部悬浮控件：返回 + 画布名（可改名）+ 保存状态 / 运行状态 / 主题切换。
              桌面与手机都展示，只有小屏的紧凑样式不同；空态页不渲染——
              那里没有「这块画布」可返回，也没得可命名 */}
          <CanvasHeader
            sessionId={sessionId}
            title={c.title}
            saveStates={c.saveStates}
            busy={c.busy}
          />
          {/* 骨架屏：盖在画布之上，快照与历史都落地（且至少驻留 500ms）后爆开退场。
              key=sessionId：切画布要从等待态重新走一遍 */}
          <CanvasBoot key={`boot-${sessionId}`} loading={c.isLoading} />
          </>
        ) : (
          /* 未选中画布 → 索引页。这一页只有「挑一块画布进去」一件事，
             所以画布内的悬浮面板与边缘入口都不出现（见下方 sessionId 门控） */
          <CanvasGallery />
        )}

        {/* 悬浮层：自身穿透点击（pointer-events-none），只有触发按钮与面板接管指针。
            索引页不挂——那里没有「当前画布」，列表/对话/缩放都无从谈起 */}
        {!isMobile && sessionId && (
          <div
            ref={setBounds}
            className="pointer-events-none absolute inset-0 z-20"
          >
            {/* 两个入口并成右侧一条竖轨（导航位置恒定，不随面板停在哪侧而变） */}
            <PanelTriggerRail side="right" inset={panels.triggerRailInset}>
              <PanelTrigger
                side="right"
                icon={<LayoutGrid className="size-5" />}
                label="Canvases"
                open={panels.listOpen}
                onClick={() => panels.setListOpen(!panels.listOpen)}
              />
              {sessionId && (
                <PanelTrigger
                  side="right"
                  // 空闲也用方阵，只是换成待机灯：这个入口是 agent 在画布上唯一的常驻
                  // 化身，静态图标看不出它是活的
                  icon={
                    <ThinkingGrid
                      size={20}
                      animation={agentUi?.animation ?? "standby"}
                    />
                  }
                  label="Canvas Agent"
                  tooltip={agentUi?.phrase ?? "Agent standing by"}
                  open={panels.chatOpen}
                  onClick={() => panels.setChatOpen(!panels.chatOpen)}
                />
              )}
            </PanelTriggerRail>

            <FloatingPanel
              panel={panels.list}
              open={panels.listOpen}
              icon={<LayoutGrid className="size-4" />}
              title="Canvases"
              pinned={panels.listPinned}
              onPinnedChange={panels.setListPinned}
              onClose={() => panels.setListOpen(false)}
            >
              {sidebar}
            </FloatingPanel>

            {sessionId && (
              <FloatingPanel
                panel={panels.chat}
                open={panels.chatOpen}
                icon={<MessagesSquare className="size-4" />}
                title="Canvas Agent"
                actions={chatActions}
                pinned={panels.chatPinned}
                onPinnedChange={panels.setChatPinned}
                onClose={() => panels.setChatOpen(false)}
              >
                {chat}
              </FloatingPanel>
            )}
          </div>
        )}
      </div>

      {/* 手机：底部固定条（拇指可达）+ 两个从下往上弹的抽屉。
          抽屉关闭时内容不挂载，但 socket 与 agent 都在 useCanvas（本组件）里，不受影响；
          代价只是关掉对话后输入框草稿不留存。 */}
      {isMobile && sessionId && (
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
              className="min-w-0 flex-1"
              disabled={!sessionId}
              onClick={() => setChatOpen(true)}
            >
              {/* 执行中：静态图标换成对应阶段的脉动方阵，文字换成该阶段文案。
                  抽屉关着时这是唯一能看到 agent 在干什么的地方 */}
              {agentUi ? (
                <ThinkingGrid size={16} animation={agentUi.animation} />
              ) : (
                <MessagesSquare className="size-4" />
              )}
              <span className="truncate">{agentUi?.phrase ?? "Chat"}</span>
            </Button>
          </nav>

          <Drawer open={listOpen} onOpenChange={setListOpen} showSwipeHandle>
            {/* --drawer-height 是 DrawerContent 的尺寸入口（默认 auto + max 100dvh-6rem） */}
            <DrawerContent className="[--drawer-height:70dvh]">
              <DrawerHeader className="sr-only">
                <DrawerTitle>Canvas list</DrawerTitle>
              </DrawerHeader>
              {/* 标题栏与桌面面板同一个组件，两处外壳里长得一致 */}
              <PanelHeader
                icon={<LayoutGrid className="size-4" />}
                title={<span className="font-semibold">Canvas workflow</span>}
                className="border-b-0 px-4 pt-3 pb-0"
              />
              <div className="min-h-0 flex-1 overflow-hidden">{sidebar}</div>
            </DrawerContent>
          </Drawer>

          <Drawer open={chatOpen} onOpenChange={setChatOpen} showSwipeHandle>
            <DrawerContent className="[--drawer-height:88dvh]">
              <DrawerHeader className="sr-only">
                <DrawerTitle>Chat</DrawerTitle>
              </DrawerHeader>
              <PanelHeader
                title="Canvas Agent"
                actions={chatActions}
                className="px-4 py-2.5"
              />
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
