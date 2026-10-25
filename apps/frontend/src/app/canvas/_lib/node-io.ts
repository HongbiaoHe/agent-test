import type {
  CanvasIoType,
  CanvasNodeDto,
  CanvasNodeOutput,
  CanvasNodeType,
  CanvasUploadNodeType,
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
  // 上传节点：每种只收一类文件，输出类型固定
  image_upload: { inputs: [], outputs: ["image"] },
  video_upload: { inputs: [], outputs: ["video"] },
  audio_upload: { inputs: [], outputs: ["audio"] },
  // 入边只提供参考素材：提示词是生成节点自己的 prompt 字段，不走连线
  image_gen: { inputs: ["image"], outputs: ["image"] },
  // 各类型能收几个看所选模型（image/video/audio_input_number），超出的不提交（见 _lib/aigc-params）
  video_gen: { inputs: ["image", "video", "audio"], outputs: ["video"] },
  // 唯一只吃视频的节点：把多段上游视频按入边顺序接成一条（本地 ffmpeg，非生成模型）
  video_concat: { inputs: ["video"], outputs: ["video"] },
};

/** 上传节点 → 它收的资产类型（= 输出端口类型）。 */
export const UPLOAD_NODE_ASSET: Record<CanvasUploadNodeType, CanvasIoType> = {
  image_upload: "image",
  video_upload: "video",
  audio_upload: "audio",
};

export function isUploadNodeType(t: CanvasNodeType): t is CanvasUploadNodeType {
  return t in UPLOAD_NODE_ASSET;
}

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
  /** 生成节点的媒体状态（queued / generating / done / failed）；还没触发过或非生成节点为 null */
  mediaStatus: string | null;
  /** 产物是测试模式（Mock）的占位素材 */
  mediaMock: boolean;
}

/** 上游还在排队 / 生成 / 暂停中：下游可以照常触发，服务端会带上它的版本并等它出结果（同后端 isInFlight）。 */
export function isInFlight(s: Pick<NodeInputSource, "mediaStatus">): boolean {
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
  if (!isInFlight(s)) return null;
  return CANVAS_NODE_IO[s.nodeType].outputs.find((t) => accepted.includes(t)) ?? null;
}

/** 节点类型的缺省名：label 为空时顶上，同时也是各处「这是哪类节点」的措辞来源。 */
export const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  image_upload: "Image upload",
  video_upload: "Video upload",
  audio_upload: "Audio upload",
  image_gen: "Image",
  video_gen: "Video",
  video_concat: "Merge",
};

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
      mediaStatus: n.mediaStatus,
      mediaMock: n.mediaMock,
    }));
}
