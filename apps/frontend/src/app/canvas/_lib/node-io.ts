import type {
  CanvasIoType,
  CanvasNodeDto,
  CanvasNodeOutput,
  CanvasNodeType,
} from "@/lib/api";

import type { CanvasState } from "./canvas-state";

/**
 * 每种节点的输入/输出契约——镜像后端 canvas.types 的 CANVAS_NODE_IO（那边是权威）。
 * 改这里必须同步改后端，否则前端放过的连线会被服务端拒。
 */
export const CANVAS_NODE_IO: Record<
  CanvasNodeType,
  { inputs: readonly CanvasIoType[]; outputs: readonly CanvasIoType[] }
> = {
  text: { inputs: [], outputs: ["text"] },
  image_upload: { inputs: [], outputs: ["image"] },
  image_gen: { inputs: ["text", "image"], outputs: ["image"] },
  // video 输入只放开连线（可串联画布），不参与生成：底层管线吃不下视频参考
  // （详见后端 canvas.types 的 CANVAS_NODE_IO 注释）
  video_gen: { inputs: ["text", "image", "video"], outputs: ["video"] },
  // 唯一只吃视频的节点：把多段上游视频按入边顺序接成一条（本地 ffmpeg，非生成模型）
  video_concat: { inputs: ["video"], outputs: ["video"] },
};

/** 连线是否合法：source 的任一输出类型被 target 接受即可。target 无输入端口 → 一律非法。 */
export function canConnectNodeTypes(
  source: CanvasNodeType,
  target: CanvasNodeType,
): boolean {
  const accepted = CANVAS_NODE_IO[target].inputs;
  return CANVAS_NODE_IO[source].outputs.some((t) => accepted.includes(t));
}

/** 一个上游来源：节点身份 + 它此刻能提供的输出。 */
export interface NodeInputSource {
  nodeId: string;
  nodeType: CanvasNodeType;
  /** 展示名（label 为空时退到类型缺省名） */
  title: string;
  outputs: CanvasNodeOutput[];
}

/** 节点类型的缺省名：label 为空时顶上，同时也是各处「这是哪类节点」的措辞来源。 */
export const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  text: "Text",
  image_upload: "Upload",
  image_gen: "Image",
  video_gen: "Video",
  video_concat: "Merge",
};

/**
 * 把关联输入里的 text 输出拼成该节点本次生成会用的提示词。
 * 必须与后端 canvas.tools 的 generate_media_node 拼法一致（单条直接用，多条按边顺序编号）。
 */
export function resolvePrompt(inputs: NodeInputSource[]): string {
  const parts = inputs.flatMap((s) =>
    s.outputs.filter((o) => o.type === "text").map((o) => o.content),
  );
  if (parts.length === 0) return "";
  return parts.length === 1
    ? parts[0]
    : parts.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

/**
 * 解析某节点的关联输入：沿入边找到上游节点，带出它们此刻的 outputs（可能为空=尚未就绪）。
 * 纯前端派生——快照里已有全部 nodes/edges，不必让后端多返一份。
 * 顺序按 edges 顺序（= 服务端 createdAt 升序），与生成时的参考图顺序一致。
 */
export function resolveNodeInputs(
  canvas: CanvasState,
  nodeId: string,
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
      title: n.label?.trim() || NODE_TYPE_LABEL[n.type],
      outputs: n.outputs,
    }));
}
