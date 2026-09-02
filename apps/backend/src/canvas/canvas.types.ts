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
  // 注：gemini-3-pro-preview 已移除——该模型 ID 在 API 上恒 404（2026-08-25 实测 5/5 失败）
  'gemini-3-flash-preview',
  'deepseek:deepseek-v4-flash',
  'deepseek:deepseek-v4-pro',
] as const;

export type CanvasModel = (typeof CANVAS_MODELS)[number];

/**
 * 敏感操作的审批模式。
 * - review：破坏性（clear_canvas）与消耗性（generate_media_node）操作暂停等用户确认，
 *   agent 需要澄清时可以 ask_user 等人回答。默认。
 * - auto：全自动。不设任何中断，agent 按自己的判断一路做完；ask_user 也不再等人，
 *   直接告诉它没人可答、自行决定。
 */
export type CanvasApprovalMode = 'review' | 'auto';

export const CANVAS_APPROVAL_MODES: readonly CanvasApprovalMode[] = [
  'review',
  'auto',
] as const;

/** 归一化：不认识的值（含 null/旧数据）一律按 review——放行是不可逆的，默认必须是保守的那个。 */
export function asApprovalMode(v: unknown): CanvasApprovalMode {
  return v === 'auto' ? 'auto' : 'review';
}

/** 画布节点类型：上传图片 / 生图 / 文本 / 生视频 / 视频拼接。 */
export type CanvasNodeType =
  | 'image_upload'
  | 'image_gen'
  | 'text'
  | 'video_gen'
  | 'video_concat';

export const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = [
  'image_upload',
  'image_gen',
  'text',
  'video_gen',
  'video_concat',
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
 * ⚠️ video_gen 的 video 输入只放开**连线**，不参与生成：底层管线吃不下视频参考——
 * media.processor 的 loadRefs 把参考版本按图片读盘（mimeForExt 不认 .mp4），media.service
 * 的 validateReferences 只放行 generation.type=image，且 Google SDK 的 GenerateVideosParameters
 * 里 image（首帧）与 video（延展源）互斥。故 video 上游可连、可用于串联画布流程，但
 * generate_media_node 会跳过它并在返回值的 skippedVideoInputs 里报出。
 *
 * video_concat 是唯一**只吃视频**的节点：把多段上游视频按入边顺序接成一条。
 * 它不调生成模型，走本地 ffmpeg（见 media/video-concat.ts），但产出同样是一个
 * MediaVersion——于是状态流转、资产接口、下游引用与生成节点完全一致。
 */
export const CANVAS_NODE_IO: Record<
  CanvasNodeType,
  { inputs: readonly CanvasIoType[]; outputs: readonly CanvasIoType[] }
> = {
  text: { inputs: [], outputs: ['text'] },
  image_upload: { inputs: [], outputs: ['image'] },
  image_gen: { inputs: ['text', 'image'], outputs: ['image'] },
  video_gen: { inputs: ['text', 'image', 'video'], outputs: ['video'] },
  video_concat: { inputs: ['video'], outputs: ['video'] },
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
  /** 思考深度档位（auto|off|on|low|medium|high）；null = 跟随模型默认。 */
  thinkingLevel: string | null;
  /** 敏感操作审批模式（归一化后，恒有值） */
  approvalMode: CanvasApprovalMode;
  revision: number;
  /** 会话累计 token（全部 run 的 totalTokens 聚合，持久化口径；实时增量走 token_usage 事件） */
  totalTokens: number;
  /**
   * 用户「加入对话」圈定的节点 id。非空时 agent 的画布上下文只列这些节点及其相邻连线，
   * 空数组 = 关注整块画布。
   */
  focusNodeIds: string[];
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
  /**
   * 思考 token = total − input − output。
   *
   * Gemini 把思考量只记进 total，既不算进 input 也不算进 output（实测 in=16 / out=742 /
   * total=1911，差的 1153 就是思考）。不单列这一项，弹窗里「输入 + 输出」就对不上「总计」。
   * DeepSeek 把 reasoning 计入 output，所以它这一项恒为 0。
   */
  reasoning: number;
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

/**
 * 注入给模型的节点 id 长度：完整 cuid 的**后 6 位**。
 *
 * 为省 prompt token —— 完整 cuid 25 字符，48 节点 + 42 连线的画布里光 id 就占掉近 2/3 篇幅。
 * 取**后缀**而非前缀：cuid 前段是时间戳，同一秒创建的节点会撞（实测 48 节点只剩 28 个唯一前 8 位）；
 * 后段是随机串，实测全库 1334 个节点后 6 位零碰撞。
 */
export const SHORT_NODE_ID_LEN = 6;

/** 完整节点 id → 注入给模型的短 id。 */
export function shortNodeId(id: string): string {
  return id.slice(-SHORT_NODE_ID_LEN);
}

/**
 * 按入边顺序收集某个 video_concat 节点的拼接源（上游视频的 MediaVersion.id）。
 *
 * 顺序即 edges 的顺序（服务端 createdAt 升序）——它同时决定了用户在卡片上看到的预览顺序
 * 与最终合成的先后，三处必须同源，否则"预览是这样、合出来是那样"。
 * agent 工具与用户手动触发的接口共用这一份，避免两条路各算各的。
 */
export function collectVideoSources(
  nodes: readonly { id: string; outputs: readonly CanvasNodeOutput[] }[],
  edges: readonly { source: string; target: string }[],
  nodeId: string,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .filter((e) => e.target === nodeId)
    .flatMap((e) => byId.get(e.source)?.outputs ?? [])
    .filter((o) => o.type === 'video')
    .map((o) => o.content);
}
