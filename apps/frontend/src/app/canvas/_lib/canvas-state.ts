import type { CanvasEdgeDto, CanvasNodeDto } from "@/lib/api";

/**
 * canvas_patch 事件 payload。前端据此把服务端的原子结构变更增量应用到本地 react-flow
 * 投影，无需每次重拉整块快照。类型定义在 lib/api（与其它服务端 DTO 放一起，
 * applyCanvasOp 的返回值也是它），这里只做转出。
 */
export type { CanvasPatch } from "@/lib/api";
import type { CanvasPatch } from "@/lib/api";

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
    case "reorder_inputs": {
      // 该节点的入边按新顺序排到末尾即可：各处都是按 target 过滤后取相对顺序（预览、合并面板、参考编号）
      const order = new Map(patch.edgeIds.map((id, i) => [id, i]));
      const others = state.edges.filter((e) => !order.has(e.id));
      const inputs = state.edges
        .filter((e) => order.has(e.id))
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return { ...state, revision: patch.revision, edges: [...others, ...inputs] };
    }
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
  // 上传节点的 add/update patch 后端都带了 media JOIN，patch 里就是准的，不能兜底
  // （否则换文件后 outputs 卡在旧值不清）。
  const joinDerived = node.type === "image_gen" || node.type === "video_gen";
  next[idx] = {
    ...node,
    // update_node 的 patch 不带 media 字段（快照才 JOIN）；保留已有状态，避免闪回 null
    mediaVersionId: node.mediaVersionId ?? nodes[idx].mediaVersionId,
    mediaStatus: node.mediaStatus ?? nodes[idx].mediaStatus,
    // 同上：没带版本的 patch 也没带 mock 标记，沿用已有值
    mediaMock: node.mediaVersionId ? node.mediaMock : nodes[idx].mediaMock,
    outputs:
      joinDerived && node.outputs.length === 0
        ? nodes[idx].outputs
        : node.outputs,
  };
  return next;
}
