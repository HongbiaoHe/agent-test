"use client";

import { LayoutGrid, MessagesSquare } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  FloatingPanel,
  PanelTrigger,
  PanelTriggerRail,
} from "@/components/ui/floating-panel";

import type { useAgentPhaseUi } from "../_hooks/use-agent-phase-ui";
import { useCanvasPanels } from "../_hooks/use-canvas-panels";
import { ThinkingGrid } from "./thinking-indicator";

/**
 * 桌面端悬浮层：右侧触发竖轨 + 列表面板 + 对话面板，以及它们的开合/钉住/摆放状态。
 *
 * **为什么单独成一个组件**：开合状态原先住在 CanvasShell 里，每按一次开合整个 shell
 * 重渲染——react-flow 全部节点、整条对话流（逐条 Markdown）、列表都在**同一帧**里同步重跑，
 * 恰好压在面板 140–200ms 淡出过渡的起始帧上，帧一掉就是肉眼可见的卡顿。CSS 那一侧早已
 * 只动 opacity/transform（见 globals.css 的 .floating-panel 注释），剩下的卡顿全来自这里。
 *
 * 状态下沉到本组件后，开合只重渲染这一层；`sidebar` / `chat` / `chatActions` 是父组件
 * 创建的元素，引用不变，React 对它们直接 bail-out——CanvasChat 与 CanvasSidebar 一行都
 * 不重跑，FlowCanvas 根本不在这条渲染路径上。
 *
 * 唯一的反向耦合是「点画布空白处收起未钉住的面板」：状态在这儿、点击在 FlowCanvas 那儿。
 * 通过 `dismissRef` 回注最新的 dismissUnpinned，父组件用一个稳定的回调转调它，
 * 免得为了这一个函数把状态又提回去。
 */
export function CanvasFloatingLayer({
  agentUi,
  sidebar,
  chat,
  chatActions,
  dismissRef,
}: {
  /** agent 当前阶段的入口表现（方阵动画 + 文案）；空闲为 null */
  agentUi: ReturnType<typeof useAgentPhaseUi>;
  sidebar: ReactNode;
  chat: ReactNode;
  chatActions: ReactNode;
  /** 父组件的转调句柄：本组件把最新的 dismissUnpinned 写进去 */
  dismissRef: { current: () => void };
}) {
  // 悬浮面板的定位基准：画布区域本身。面板绝对定位在它里面，不再占布局宽度。
  // 存元素而不是 ref：这个容器会随桌面/手机分支整个换掉，用 state 才能让面板的
  // ResizeObserver 跟着换到新节点上（否则会一直量旧节点的 0×0）
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null);
  const panels = useCanvasPanels(bounds);

  useEffect(() => {
    dismissRef.current = panels.dismissUnpinned;
  }, [dismissRef, panels.dismissUnpinned]);

  return (
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
    </div>
  );
}
