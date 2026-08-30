"use client";

import {
  Background,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useEffect, useMemo, useRef } from "react";

import type { CanvasOpInput } from "@/lib/api";

import type { CanvasState } from "../_lib/canvas-state";
import {
  canConnectNodeTypes,
  resolveNodeInputs,
  type NodeInputSource,
} from "../_lib/node-io";
import type { SaveState } from "../_hooks/use-canvas";
import { edgeTypes, type FlowEdgeData } from "./canvas-edges";
import { nodeTypes } from "./canvas-nodes";
import { CanvasZoomControls } from "./canvas-zoom-controls";

/** 节点内容可编辑字段（update_node op 的子集，位置/媒体不在此列）。 */
export interface NodeContentPatch {
  label?: string;
  text?: string;
}

/**
 * 节点编辑上下文：react-flow 自定义节点只拿 data，编辑回调与保存状态经 context 注入
 * （canvas-nodes.tsx / node-editor-toolbar.tsx 消费）。
 * updateNode 落到 update_node op（revision CAS 自动保存）；saveStates 驱动 loading 反馈。
 */
export const CanvasEditorContext = createContext<{
  readOnly: boolean;
  updateNode: (nodeId: string, patch: NodeContentPatch) => void;
  saveStates: Record<string, SaveState>;
  /** 键入即亮 loading（防抖未到点也显示） */
  markSaving: (nodeId: string) => void;
  /** 内容回退到原值、最终无 op 可发 → 撤销 loading */
  cancelSaving: (nodeId: string) => void;
  /** 沿入边解析该节点的关联输入（浮窗展示用） */
  resolveInputs: (nodeId: string) => NodeInputSource[];
  /** 取消全部选中：手机上编辑抽屉关闭时要连带取消选中，否则 selected 还在、抽屉会立刻弹回 */
  clearSelection: () => void;
  /** 删除节点（落 remove_node op，服务端级联删相关边） */
  deleteNode: (nodeId: string) => void;
}>({
  readOnly: true,
  updateNode: () => {},
  saveStates: {},
  markSaving: () => {},
  cancelSaving: () => {},
  resolveInputs: () => [],
  clearSelection: () => {},
  deleteNode: () => {},
});

function toRfNodes(canvas: CanvasState): Node[] {
  return canvas.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data: { ...n },
  }));
}

function toRfEdges(canvas: CanvasState): Edge[] {
  // 目标节点正在生成 → 该入边常驻流光（表现数据正流入这个节点）
  const generating = new Set(
    canvas.nodes.filter((n) => n.mediaStatus === "generating").map((n) => n.id),
  );
  return canvas.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "flow",
    data: { busy: generating.has(e.target) },
  }));
}

/**
 * agent 操控期，把**刚新增的节点**聚焦到画布窗口中央（而非 fit 全部）。必须作为 <ReactFlow>
 * 子组件才能拿到上下文。做法：记录上一次的节点 id 集合，每次变化算出新增的 id，用
 * fitView({ nodes }) 只对新增节点做视野——例如新增 3 个节点，就把这 3 个居中展示。
 * 首次挂载只记录基线不聚焦（初始视图由 fitView prop 处理）；空闲期不自动聚焦，避免打断用户平移。
 */
/**
 * 保存状态徽标（画布左上角，全画布唯一一处）：聚合所有节点的 update_node 状态。
 * 任一节点在保存 → 保存中；否则有失败 → 失败；否则刚成功 → 已保存；都没有则不渲染。
 */
/**
 * 首帧聚焦：快照异步落地时 mount 时点节点为空，<ReactFlow fitView> 落空——
 * 首次节点从空变非空后补一次 fitView。一次性（ref），随 FlowCanvas key=sessionId 重挂载重置。
 */
function FitOnFirstLoad({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || count === 0) return;
    done.current = true;
    // 下一帧执行：等本次渲染的节点 DOM 就位再取包围盒
    requestAnimationFrame(() => {
      void fitView({ padding: 0.2, maxZoom: 1.2 });
    });
  }, [count, fitView]);
  return null;
}

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
  saveStates,
  onMarkSaving,
  onCancelSaving,
  onPaneClick,
}: {
  canvas: CanvasState;
  readOnly: boolean;
  onMoveNode: (nodeId: string, x: number, y: number) => void;
  onApplyOp: (op: CanvasOpInput) => void;
  /** update_node 保存状态（nodeId → saving/saved/error），驱动画布左上角保存指示 */
  saveStates: Record<string, SaveState>;
  /** 键入即亮 loading（防抖窗口内也显示） */
  onMarkSaving: (nodeId: string) => void;
  /** 内容回退到原值、无 op 可发 → 撤销 loading */
  onCancelSaving: (nodeId: string) => void;
  /** 点画布空白处（不含节点/连线）：桌面端据此收起未钉住的悬浮面板 */
  onPaneClick?: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // 外部画布状态（快照 / canvas_patch / media 刷新）变化时重建 RF 视图。
  // 本地拖拽不改 canvas，故不会在拖拽中被打断。
  // ⚠️ 必须保留 selected：update_node 成功后服务端回广播 canvas_patch，整表重建会丢掉
  // 选中态 → 正在编辑的浮窗（NodeToolbar 依赖 selected）会在保存成功那刻突然消失。
  useEffect(() => {
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return toRfNodes(canvas).map((n) =>
        selected.has(n.id) ? { ...n, selected: true } : n,
      );
    });
  }, [canvas, setNodes]);
  useEffect(() => {
    setEdges(toRfEdges(canvas));
  }, [canvas, setEdges]);

  // 选中节点的全部关联连线（进+出）也跑流光。选中态只存在于 RF 本地 state，故在这里派生而不进
  // toRfEdges；用 id 串成 key 而不是直接依赖 nodes——nodes 每个拖拽帧都变，否则每帧重算。
  const selectedKey = nodes
    .filter((n) => n.selected)
    .map((n) => n.id)
    .sort()
    .join("|");
  const flowEdges = useMemo(() => {
    const selected = new Set(selectedKey ? selectedKey.split("|") : []);
    return edges.map((e) => {
      const data: FlowEdgeData = e.data ?? {};
      const active =
        data.busy === true || selected.has(e.source) || selected.has(e.target);
      // 无变化就返回原对象，避免每次渲染都给 react-flow 换新引用
      return active === (data.active ?? false)
        ? e
        : { ...e, data: { ...data, active } };
    });
  }, [edges, selectedKey]);

  // 节点编辑上下文（canvas-nodes / node-editor-toolbar 消费）：
  // 内容变更 → update_node op 自动保存；saveStates 供浮窗与节点角标显示进度
  const editor = useMemo(
    () => ({
      readOnly,
      updateNode: (nodeId: string, patch: NodeContentPatch) =>
        onApplyOp({ op: "update_node", nodeId, ...patch }),
      saveStates,
      markSaving: onMarkSaving,
      cancelSaving: onCancelSaving,
      resolveInputs: (nodeId: string) => resolveNodeInputs(canvas, nodeId),
      clearSelection: () =>
        setNodes((prev) =>
          prev.some((n) => n.selected)
            ? prev.map((n) => (n.selected ? { ...n, selected: false } : n))
            : prev,
        ),
      deleteNode: (nodeId: string) =>
        onApplyOp({ op: "remove_node", nodeId }),
    }),
    [
      readOnly,
      onApplyOp,
      saveStates,
      onMarkSaving,
      onCancelSaving,
      canvas,
      setNodes,
    ],
  );

  // Cmd/Ctrl+D 快捷复制选中节点（+40,+40 偏移；生成态/媒资不随副本）。
  // window 级监听 + 输入场景守卫：react-flow 面板焦点不稳定，元素级 onKeyDown 会漏事件。
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "d") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return; // 正在输入：不劫持
      }
      const selected = nodesRef.current.filter((n) => n.selected);
      if (selected.length === 0) return; // 无选中：保留浏览器默认行为
      e.preventDefault();
      for (const n of selected) {
        const d = n.data as {
          type?: string;
          label?: string | null;
          text?: string | null;
          assetPath?: string | null;
        };
        onApplyOp({
          op: "add_node",
          type: (n.type ?? "text") as "text",
          label: d.label ?? undefined,
          text: d.text ?? undefined,
          assetPath: d.assetPath ?? undefined,
          x: n.position.x + 40,
          y: n.position.y + 40,
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly, onApplyOp]);

  return (
    <div className="relative h-full w-full">
      <CanvasEditorContext.Provider value={editor}>
      <ReactFlow
        nodes={nodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={onPaneClick}
        onNodeDragStop={(_e, node) => {
          // d3-drag 对「按下即松开」的纯点击同样发 dragStop：位置没变就当点击处理，
          // 保持选中让编辑浮窗浮出，也不发无意义的 move_node op。
          const origin = canvas.nodes.find((n) => n.id === node.id);
          if (
            origin &&
            origin.x === node.position.x &&
            origin.y === node.position.y
          ) {
            return;
          }
          onMoveNode(node.id, node.position.x, node.position.y);
          // 真拖动过：落点后取消选中，别让编辑浮窗跟着弹出来
          setNodes((prev) =>
            prev.map((n) => (n.id === node.id ? { ...n, selected: false } : n)),
          );
        }}
        onConnect={(c: Connection) => {
          if (readOnly || !c.source || !c.target) return;
          onApplyOp({ op: "add_edge", source: c.source, target: c.target });
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        /* 删除必须落 remove_node op：onNodesChange 只改本地 react-flow 状态，
           服务端不知情，刷新或下一条 canvas_patch 一到节点就回来了。
           运行期把删除键关掉（deleteKeyCode=null），与其它结构编辑一致只读。 */
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        /* 用 onDelete 而不是 onNodesDelete + onEdgesDelete：一次拿到本次删除的节点与边，
           不必靠 selected 反推谁正在被删。
           过滤「两端有节点同时被删」的边：服务端 remove_node 已级联删掉它们，再发
           remove_edge 只是多一轮必然 404/无效的请求。 */
        onDelete={({ nodes: goneNodes, edges: goneEdges }) => {
          if (readOnly) return;
          const dying = new Set(goneNodes.map((n) => n.id));
          for (const n of goneNodes) {
            onApplyOp({ op: "remove_node", nodeId: n.id });
          }
          for (const e of goneEdges) {
            if (dying.has(e.source) || dying.has(e.target)) continue;
            onApplyOp({ op: "remove_edge", edgeId: e.id });
          }
        }}
        /* 触控板双指滚动 = 平移画布（panOnScroll）；关掉 zoomOnScroll 让双指滚动只平移不缩放。
           缩放仍可：捏合(zoomOnPinch 默认开) / Cmd+滚动(zoomActivationKeyCode 默认 Meta) / 左下缩放键。
           拖拽平移(panOnDrag 默认开)保留。 */
        /* 拖线时就按类型契约拦掉非法连接（后端 add_edge 也会校验，这里只是不让用户白拖一趟）。
           isValidConnection 在拖拽过程中被反复调用，故直接查 canvas.nodes 不做额外状态。 */
        isValidConnection={(c) => {
          if (!c.source || !c.target || c.source === c.target) return false;
          const src = canvas.nodes.find((n) => n.id === c.source);
          const dst = canvas.nodes.find((n) => n.id === c.target);
          return !!src && !!dst && canConnectNodeTypes(src.type, dst.type);
        }}
        panOnScroll
        zoomOnScroll={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <CanvasZoomControls />
        {/* 首帧聚焦：快照落地后补一次 fitView（修"切画布空白"） */}
        <FitOnFirstLoad count={nodes.length} />
        {/* agent 操控期：把刚新增的节点聚焦到画布中央 */}
        <FitOnChange
          nodeIdsKey={nodes.map((n) => n.id).join("|")}
          active={readOnly}
        />
      </ReactFlow>
      </CanvasEditorContext.Provider>
      {/* 四周呼吸式光晕：表现 AI 正在奋力操控画布（动效见 globals.css .canvas-working-overlay）。
          「Agent working / 只读」的文字状态在顶部 header 里，不在画布内 */}
      {readOnly && <div className="canvas-working-overlay" aria-hidden />}
    </div>
  );
}
