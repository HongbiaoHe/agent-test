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

/** 节点端口上流动的资源类型。连线合法性与 outputs 形状都以它为单位。 */
export type CanvasIoType = 'text' | 'image' | 'video';

/**
 * 节点的一份输出。统一包成对象数组便于扩展——当前每个节点恒为 0 或 1 份。
 * content 的语义随 type 变：
 *  - text        → 字面文本；
 *  - image/video → MediaVersion.id（前端经带鉴权的 blob 接口取资产）；
 *  - 例外：image_upload 目前是 MVP 模拟上传，没有 MediaVersion，content 存 assetPath。
 */
export interface CanvasNodeOutput {
  type: CanvasIoType;
  content: string;
}

/**
 * 每种节点的输入/输出契约（后端权威，前端在 canvas/_lib/node-io.ts 镜像）。
 * 入边数量不限（多输入），outputs 也是数组（多输出）——当前生成管线一次只产一份。
 *
 * 生成节点自身不带提示词：prompt 与参考图**全部来自入边**（上游 text 输出拼成提示词，
 * 上游 image 输出作参考图），见 canvas.tools 的 generate_media_node。
 *
 * ⚠️ video_gen 暂不接受 video 输入：底层管线吃不下视频参考——media.processor 的 loadRefs
 * 把参考版本按图片读盘，视频生成只用 refs[0] 当首帧。等管线支持了再往 inputs 里加 'video'。
 */
export const CANVAS_NODE_IO: Record<
  CanvasNodeType,
  { inputs: readonly CanvasIoType[]; outputs: readonly CanvasIoType[] }
> = {
  text: { inputs: [], outputs: ['text'] },
  image_upload: { inputs: [], outputs: ['image'] },
  image_gen: { inputs: ['text', 'image'], outputs: ['image'] },
  video_gen: { inputs: ['text', 'image'], outputs: ['video'] },
};

/**
 * 连线是否合法：source 的任一输出类型被 target 接受即可。
 * target 无输入端口（text / image_upload）→ 一律非法。
 */
export function canConnectNodeTypes(
  source: CanvasNodeType,
  target: CanvasNodeType,
): boolean {
  const accepted = CANVAS_NODE_IO[target].inputs;
  return CANVAS_NODE_IO[source].outputs.some((t) => accepted.includes(t));
}

/**
 * 节点对外形状（REST 快照 + patch 事件 node 字段）。
 * media 字段（mediaVersionId/mediaStatus）由快照层按 mediaGenerationId JOIN MediaVersion 算出，
 * 不落 CanvasNode 表（避免脆弱回写）。outputs 同理是派生字段。
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
  /**
   * 该节点当前可供下游消费的输出（派生，不落表）。未就绪时为空数组：
   * text 正文为空、image_upload 未上传、生成节点未 done 都是 []。
   * ⚠️ patch 事件里的 node 不带 media JOIN，生成节点的 outputs 会是 []——
   * 前端 applyPatch 的 upsertNode 已对此做保留旧值兜底，勿依赖 patch 里的 outputs。
   */
  outputs: CanvasNodeOutput[];
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
  /** 会话累计 token（全部 run 的 totalTokens 聚合，持久化口径；实时增量走 token_usage 事件） */
  totalTokens: number;
  nodes: CanvasNodeDto[];
  edges: CanvasEdgeDto[];
}

// ─────────────────────────────────────────────────────────────────────────────
// token 用量报表（GET /canvas/:id/token-usage）
// 口径：cacheRead / cacheCreation 都是 input 的**子集**（provider 的 input_tokens 已含缓存部分），
// 因此缓存命中率 = cacheRead / input，不能拿 total 当分母。
// ─────────────────────────────────────────────────────────────────────────────

/** 一组调用的合计。 */
export interface CanvasTokenTotals {
  /** 模型调用次数 */
  calls: number;
  input: number;
  output: number;
  total: number;
  /** 命中缓存被读取的输入 token（⊆ input） */
  cacheRead: number;
  /** 写入缓存的输入 token（⊆ input） */
  cacheCreation: number;
}

/** 按模型分组的合计。 */
export interface CanvasTokenModelUsage extends CanvasTokenTotals {
  model: string;
}

/** 一次模型调用的明细。 */
export interface CanvasTokenCall {
  id: string;
  model: string;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
  at: string;
}

/** 一轮运行（CanvasRun）的用量：合计 + 按模型 + 每次调用明细。 */
export interface CanvasTokenRun {
  runId: string;
  /** 本轮请求的模型（会话当轮设置）；真实调用模型见 byModel / calls */
  requestedModel: string | null;
  status: string;
  /** 触发本轮的用户目标文本（可能为空，如超时自动续跑） */
  goal: string;
  startedAt: string;
  endedAt: string | null;
  totals: CanvasTokenTotals;
  byModel: CanvasTokenModelUsage[];
  calls: CanvasTokenCall[];
}

/** 会话级 token 报表。 */
export interface CanvasTokenReport {
  totals: CanvasTokenTotals;
  byModel: CanvasTokenModelUsage[];
  /** 按轮倒序（最新一轮在前） */
  runs: CanvasTokenRun[];
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
