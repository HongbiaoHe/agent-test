"use client";

import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Loader2, Lock } from "lucide-react";
import { useEffect, useRef } from "react";

import type { CanvasOpInput } from "@/lib/api";

import type { CanvasState } from "../_lib/canvas-state";
import { nodeTypes } from "./canvas-nodes";

function toRfNodes(canvas: CanvasState): Node[] {
  return canvas.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data: { ...n },
  }));
}

function toRfEdges(canvas: CanvasState): Edge[] {
  return canvas.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }));
}

/**
 * agent 操控期，把**刚新增的节点**聚焦到画布窗口中央（而非 fit 全部）。必须作为 <ReactFlow>
 * 子组件才能拿到上下文。做法：记录上一次的节点 id 集合，每次变化算出新增的 id，用
 * fitView({ nodes }) 只对新增节点做视野——例如新增 3 个节点，就把这 3 个居中展示。
 * 首次挂载只记录基线不聚焦（初始视图由 fitView prop 处理）；空闲期不自动聚焦，避免打断用户平移。
 */
function FitOnChange({
  nodeIdsKey,
  active,
}: {
  /** 当前全部节点 id 以 '|' 连接（仅在节点集合增删时变化，拖拽/选中不变）。 */
  nodeIdsKey: string;
  active: boolean;
}) {
  const { fitView } = useReactFlow();
  // 基线：上次已聚焦（或初始/空闲对齐）的节点集合。只在真正聚焦后推进。
  const baseIds = useRef<Set<string> | null>(null);
  // 固定收集窗口计时器：**第一个新节点到达时开一个 500ms 窗口，期间不重置**；
  // 窗口结束时把这 500ms 内新增的所有节点作为一批一起聚焦。
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新节点 id 键（供窗口到点时读取窗口内累积到的最新节点，而非窗口开始时的快照）。
  const latestKey = useRef(nodeIdsKey);

  useEffect(() => {
    latestKey.current = nodeIdsKey;
    const ids = nodeIdsKey ? nodeIdsKey.split("|") : [];
    if (baseIds.current === null) {
      baseIds.current = new Set(ids); // 首次记基线，不聚焦
      return;
    }
    if (!active) {
      // 空闲期不聚焦，对齐基线；若有未结束的窗口一并取消
      baseIds.current = new Set(ids);
      if (windowTimer.current) {
        clearTimeout(windowTimer.current);
        windowTimer.current = null;
      }
      return;
    }
    const added = ids.filter((id) => !baseIds.current!.has(id));
    // 无新增，或 500ms 收集窗口已在计时（本次新增会在窗口到点时被计入）→ 不新开窗口
    if (added.length === 0 || windowTimer.current) return;
    windowTimer.current = setTimeout(() => {
      windowTimer.current = null;
      const curIds = latestKey.current ? latestKey.current.split("|") : [];
      const base = baseIds.current ?? new Set<string>();
      const batch = curIds.filter((id) => !base.has(id)); // 窗口内累积的全部新增
      baseIds.current = new Set(curIds);
      if (batch.length === 0) return;
      void fitView({
        nodes: batch.map((id) => ({ id })),
        padding: 0.35,
        duration: 500,
        maxZoom: 1.2,
      });
    }, 500);
  }, [nodeIdsKey, active, fitView]);

  // 卸载时清理未结束的窗口计时器
  useEffect(
    () => () => {
      if (windowTimer.current) clearTimeout(windowTimer.current);
    },
    [],
  );
  return null;
}

export function FlowCanvas({
  canvas,
  readOnly,
  onMoveNode,
  onApplyOp,
}: {
  canvas: CanvasState;
  readOnly: boolean;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onApplyOp: (op: CanvasOpInput) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 外部画布状态（快照 / canvas_patch / media 刷新）变化时重建 RF 视图。
  // 本地拖拽不改 canvas，故不会在拖拽中被打断。
  useEffect(() => {
    setNodes(toRfNodes(canvas));
  }, [canvas, setNodes]);
  useEffect(() => {
    setEdges(toRfEdges(canvas));
  }, [canvas, setEdges]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_e, node) =>
          onMoveNode(node.id, node.position.x, node.position.y)
        }
        onConnect={(c: Connection) => {
          if (readOnly || !c.source || !c.target) return;
          onApplyOp({ op: "add_edge", source: c.source, target: c.target });
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        /* 触控板双指滚动 = 平移画布（panOnScroll）；关掉 zoomOnScroll 让双指滚动只平移不缩放。
           缩放仍可：捏合(zoomOnPinch 默认开) / Cmd+滚动(zoomActivationKeyCode 默认 Meta) / 左下缩放键。
           拖拽平移(panOnDrag 默认开)保留。 */
        panOnScroll
        zoomOnScroll={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        {/* agent 操控期：把刚新增的节点聚焦到画布中央 */}
        <FitOnChange
          nodeIdsKey={nodes.map((n) => n.id).join("|")}
          active={readOnly}
        />
      </ReactFlow>
      {readOnly && (
        <>
          {/* 四周呼吸式光晕：表现 AI 正在奋力操控画布（动效见 globals.css .canvas-working-overlay） */}
          <div className="canvas-working-overlay" aria-hidden />
          <div className="canvas-working-badge pointer-events-none absolute right-4 top-4 z-10 flex items-center gap-2.5 rounded-full border border-border/60 bg-card/70 py-1.5 pl-2.5 pr-3 text-xs shadow-lg backdrop-blur-md">
            <Loader2
              className="size-3.5 animate-spin text-foreground/80"
              strokeWidth={2.5}
            />
            <span className="font-medium text-foreground">Agent 工作中</span>
            <span className="h-3 w-px bg-border" aria-hidden />
            <span className="flex items-center gap-1 text-muted-foreground">
              <Lock className="size-3" strokeWidth={2.5} />
              画布只读
            </span>
          </div>
        </>
      )}
    </div>
  );
}
