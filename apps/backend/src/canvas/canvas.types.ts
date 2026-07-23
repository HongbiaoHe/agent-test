/**
 * 画布领域类型（后端权威定义，前端镜像同名类型）。
 *
 * 设计见 docs/superpowers/specs/2026-07-22-canvas-workflow-agent-design.md：
 * 服务端单一真相源、前端为投影——所有结构变更经 CanvasService.applyOp 事务化写入
 * （物化表 + CanvasOp 日志 + revision）并广播 canvas_patch，前端据此增量更新 react-flow。
 */

/**
 * 画布 agent 可选模型白名单。画布**独立**维护，不复用现有 agent 的 ALLOWED_MODELS —— 换画布
 * 模型清单不波及主 agent。DTO 校验（后端）+ 前端切换器共用同一份列表（前端在
 * apps/frontend/.../canvas/_lib/models.ts 镜像）。
 * 标识约定（对齐 canvas.agent.factory 的 resolveChatModel）：
 *  - 裸名（无冒号）→ google-genai provider（Gemini）；
 *  - `deepseek:<model>` → deepseek provider（需 DEEPSEEK_API_KEY，@langchain/deepseek）。
 * DeepSeek 型号取自其 /models API 的全部模型（deepseek-v4-flash / deepseek-v4-pro）。
 */
export const CANVAS_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'deepseek:deepseek-v4-flash',
  'deepseek:deepseek-v4-pro',
] as const;

export type CanvasModel = (typeof CANVAS_MODELS)[number];

/** 画布节点类型：上传图片 / 生图 / 文本 / 生视频。 */
export type CanvasNodeType =
  | 'image_upload'
  | 'image_gen'
  | 'text'
  | 'video_gen';

export const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = [
  'image_upload',
  'image_gen',
  'text',
  'video_gen',
] as const;

export function isCanvasNodeType(v: unknown): v is CanvasNodeType {
  return (
    typeof v === 'string' &&
    (CANVAS_NODE_TYPES as readonly string[]).includes(v)
  );
}

/**
 * 节点对外形状（REST 快照 + patch 事件 node 字段）。
 * media 字段（mediaVersionId/mediaStatus）由快照层按 mediaGenerationId JOIN MediaVersion 算出，
 * 不落 CanvasNode 表（避免脆弱回写）。
 */
export interface CanvasNodeDto {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  version: number;
  label: string | null;
  text: string | null;
  prompt: string | null;
  assetPath: string | null;
  mediaGenerationId: string | null;
  /** 生成节点最新版本 id（JOIN 得出，供前端拉资产）。 */
  mediaVersionId: string | null;
  /** 生成节点最新状态：queued|generating|done|failed（JOIN 得出）。 */
  mediaStatus: string | null;
}

/** 一条连线的对外形状。 */
export interface CanvasEdgeDto {
  id: string;
  source: string;
  target: string;
}

/** 画布完整快照（GET /canvas/:id 返回）。 */
export interface CanvasSnapshot {
  id: string;
  title: string;
  status: string;
  model: string | null;
  revision: number;
  nodes: CanvasNodeDto[];
  edges: CanvasEdgeDto[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 操作（op）—— applyOp 的输入。结构变更收敛到这几种，位置 move 走独立 LWW 路径不在此列。
// ─────────────────────────────────────────────────────────────────────────────

export interface AddNodeOp {
  op: 'add_node';
  type: CanvasNodeType;
  x?: number;
  y?: number;
  label?: string;
  text?: string;
  prompt?: string;
  assetPath?: string;
}

export interface UpdateNodeOp {
  op: 'update_node';
  nodeId: string;
  label?: string;
  text?: string;
  prompt?: string;
  assetPath?: string;
  mediaGenerationId?: string;
  /** 位置（可选）：update_node 也可移动节点，与改 data 一样是结构变更（占 revision）。 */
  x?: number;
  y?: number;
}

export interface RemoveNodeOp {
  op: 'remove_node';
  nodeId: string;
}

export interface AddEdgeOp {
  op: 'add_edge';
  source: string;
  target: string;
}

export interface RemoveEdgeOp {
  op: 'remove_edge';
  edgeId: string;
}

/** 清空整块画布（删除全部节点与连线）——一次原子操作，用于"删除所有节点"。 */
export interface ClearOp {
  op: 'clear';
}

export type CanvasOpInput =
  | AddNodeOp
  | UpdateNodeOp
  | RemoveNodeOp
  | AddEdgeOp
  | RemoveEdgeOp
  | ClearOp;

/** 操作发起方。 */
export type CanvasActor = 'agent' | 'user';

// ─────────────────────────────────────────────────────────────────────────────
// canvas_patch 事件 payload：一次原子结构变更（前端据此增量更新 react-flow）。
// 除 move_node 外均带变更后 revision；revision 跳变 >1 说明漏事件 → 前端重拉快照兜底。
// ─────────────────────────────────────────────────────────────────────────────

export type CanvasPatch =
  | { op: 'add_node'; node: CanvasNodeDto; revision: number }
  | { op: 'update_node'; node: CanvasNodeDto; revision: number }
  | { op: 'move_node'; nodeId: string; x: number; y: number }
  | { op: 'remove_node'; nodeId: string; revision: number }
  | { op: 'add_edge'; edge: CanvasEdgeDto; revision: number }
  | { op: 'remove_edge'; edgeId: string; revision: number }
  | { op: 'clear'; revision: number };

/** applyOp 的返回：新 revision + 广播出去的 patch。 */
export interface ApplyOpResult {
  revision: number;
  patch: CanvasPatch;
}

/** token_usage 事件 payload（只推流，不落 CanvasMessage）：本次调用增量 + 运行累计。 */
export interface TokenUsagePayload {
  runId: string;
  model: string;
  input: number;
  output: number;
  total: number;
  cumulativeTotal: number;
}
