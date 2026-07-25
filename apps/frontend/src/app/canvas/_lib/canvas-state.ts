import type { CanvasEdgeDto, CanvasNodeDto } from "@/lib/api";

/**
 * canvas_patch 事件 payload（镜像后端 CanvasPatch）。前端据此把服务端的原子结构变更
 * 增量应用到本地 react-flow 投影，无需每次重拉整块快照。
 */
export type CanvasPatch =
  | { op: "add_node"; node: CanvasNodeDto; revision: number }
  | { op: "update_node"; node: CanvasNodeDto; revision: number }
  | { op: "move_node"; nodeId: string; x: number; y: number }
  | { op: "remove_node"; nodeId: string; revision: number }
  | { op: "add_edge"; edge: CanvasEdgeDto; revision: number }
  | { op: "remove_edge"; edgeId: string; revision: number }
  | { op: "clear"; revision: number };

export interface CanvasState {
  nodes: CanvasNodeDto[];
  edges: CanvasEdgeDto[];
  revision: number;
}

/** 把一个 patch 应用到画布投影，返回新 state（不可变）。 */
export function applyPatch(state: CanvasState, patch: CanvasPatch): CanvasState {
  switch (patch.op) {
    case "add_node":
      return {
        ...state,
        revision: patch.revision,
        nodes: upsertNode(state.nodes, patch.node),
      };
    case "update_node":
      return {
        ...state,
        revision: patch.revision,
        nodes: upsertNode(state.nodes, patch.node),
      };
    case "move_node":
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === patch.nodeId ? { ...n, x: patch.x, y: patch.y } : n,
        ),
      };
    case "remove_node":
      return {
        ...state,
        revision: patch.revision,
        nodes: state.nodes.filter((n) => n.id !== patch.nodeId),
        edges: state.edges.filter(
          (e) => e.source !== patch.nodeId && e.target !== patch.nodeId,
        ),
      };
    case "add_edge":
      return {
        ...state,
        revision: patch.revision,
        edges: state.edges.some((e) => e.id === patch.edge.id)
          ? state.edges
          : [...state.edges, patch.edge],
      };
    case "remove_edge":
      return {
        ...state,
        revision: patch.revision,
        edges: state.edges.filter((e) => e.id !== patch.edgeId),
      };
    case "clear":
      return { ...state, revision: patch.revision, nodes: [], edges: [] };
  }
}

function upsertNode(
  nodes: CanvasNodeDto[],
  node: CanvasNodeDto,
): CanvasNodeDto[] {
  const idx = nodes.findIndex((n) => n.id === node.id);
  if (idx === -1) return [...nodes, node];
  const next = nodes.slice();
  // 只有生成节点的 outputs 依赖 media JOIN，patch 里恒为空 → 沿用旧值，避免闪回「未生成」。
  // text / image_upload 的 outputs 只看节点自身字段，patch 里就是准的，不能兜底
  // （否则清空正文后 outputs 卡在旧值不清）。
  const joinDerived = node.type === "image_gen" || node.type === "video_gen";
  next[idx] = {
    ...node,
    // update_node 的 patch 不带 media 字段（快照才 JOIN）；保留已有状态，避免闪回 null
    mediaVersionId: node.mediaVersionId ?? nodes[idx].mediaVersionId,
    mediaStatus: node.mediaStatus ?? nodes[idx].mediaStatus,
    outputs:
      joinDerived && node.outputs.length === 0
        ? nodes[idx].outputs
        : node.outputs,
  };
  return next;
}
