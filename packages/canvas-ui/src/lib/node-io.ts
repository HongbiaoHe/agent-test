import {
  CANVAS_NODE_IO,
  type CanvasIoType,
  type CanvasNodeDto,
  type CanvasNodeOutput,
  type CanvasNodeType,
  type CanvasState,
} from "@agent-test/canvas-schema";

/**
 * 节点端口契约与上游解析。契约本身（CANVAS_NODE_IO / canConnectNodeTypes / UPLOAD_NODE_ASSET / isUploadNodeType）
 * 来自 @agent-test/canvas-schema——后端用的也是同一份，前后端不会再各写一套。
 */

/** 一个上游来源：节点身份 + 它此刻能提供的输出。 */
export interface NodeInputSource {
  nodeId: string;
  nodeType: CanvasNodeType;
  /** 展示名（label 为空时退到类型缺省名） */
  title: string;
  outputs: CanvasNodeOutput[];
  /** 生成节点的媒体状态（queued / generating / done / failed）；还没触发过或非生成节点为 null */
  mediaStatus: string | null;
  /** 产物是测试模式（Mock）的占位素材 */
  mediaMock: boolean;
}

/**
 * 上游还在排队 / 生成 / 暂停中：下游可以照常触发，服务端会带上它的版本并等它出结果。
 * 与 canvas-schema 的 isInFlight 同一组状态，但只看 mediaStatus（NodeInputSource 不带 mediaVersionId）。
 */
export function isSourceInFlight(s: Pick<NodeInputSource, "mediaStatus">): boolean {
  return (
    s.mediaStatus === "queued" ||
    s.mediaStatus === "generating" ||
    s.mediaStatus === "paused"
  );
}

/** 这一路上游此刻（或在途完成后）给目标提供哪类素材；收不了 / 既没产物也没在生成 → null。 */
export function upstreamOutputType(
  s: Pick<NodeInputSource, "nodeType" | "outputs" | "mediaStatus">,
  accepted: readonly CanvasIoType[],
): CanvasIoType | null {
  if (s.outputs.length > 0) {
    return s.outputs.find((o) => accepted.includes(o.type))?.type ?? null;
  }
  if (!isSourceInFlight(s)) return null;
  return CANVAS_NODE_IO[s.nodeType].outputs.find((t) => accepted.includes(t)) ?? null;
}

/**
 * 解析某节点的关联输入：沿入边找到上游节点，带出它们此刻的 outputs（可能为空=尚未就绪）。
 * 纯前端派生——快照里已有全部 nodes/edges，不必让后端多返一份。
 * 顺序按 edges 顺序（= 服务端 createdAt 升序），与生成时的参考图顺序一致。
 * typeLabels：label 为空时顶上的类型缺省名（随界面语言，见 i18n 的 nodeType）。
 */
export function resolveNodeInputs(
  canvas: CanvasState,
  nodeId: string,
  typeLabels: Record<CanvasNodeType, string>,
): NodeInputSource[] {
  const byId = new Map<string, CanvasNodeDto>(
    canvas.nodes.map((n) => [n.id, n]),
  );
  return canvas.edges
    .filter((e) => e.target === nodeId)
    .map((e) => byId.get(e.source))
    .filter((n): n is CanvasNodeDto => !!n)
    .map((n) => ({
      nodeId: n.id,
      nodeType: n.type,
      title: n.label?.trim() || typeLabels[n.type],
      outputs: n.outputs,
      mediaStatus: n.mediaStatus,
      mediaMock: n.mediaMock,
    }));
}
