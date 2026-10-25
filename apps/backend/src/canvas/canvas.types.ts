/**
 * 画布领域类型（后端权威定义，前端镜像同名类型）。
 *
 * 设计见 docs/superpowers/specs/2026-07-22-canvas-workflow-agent-design.md：
 * 服务端单一真相源、前端为投影——所有结构变更经 CanvasService.applyOp 事务化写入
 * （物化表 + CanvasOp 日志 + revision）并广播 canvas_patch，前端据此增量更新 react-flow。
 */

import type {
  TokenCall,
  TokenModelUsage,
  TokenTotals,
} from '../agent/token-usage';

/**
 * 画布 agent 可选模型白名单。画布**独立**维护，不复用现有 agent 的 ALLOWED_MODELS —— 换画布
 * 模型清单不波及主 agent。DTO 校验（后端）+ 前端切换器共用同一份列表（前端在
 * apps/frontend/.../canvas/_lib/models.ts 镜像）。
 * 标识约定（对齐 canvas.agent.factory 的 resolveChatModel）：
 *  - 裸名（无冒号）→ google-genai provider（Gemini）；
 *  - `deepseek:<model>` → deepseek provider（需 DEEPSEEK_API_KEY，@langchain/deepseek）。
 * DeepSeek 型号取自其 /models API 的全部模型（2026-09-15 实测：deepseek-flash / deepseek-v4-pro）。
 * 注：deepseek-v4-flash 是它的旧名，官方已下线该 ID 并改由 V4.1-Flash 承接；这里只留新名，
 * 存量会话里的旧名已一并改写（旧名上游仍可调，但没必要继续用一个会消失的 ID）。
 * Gemini 型号对齐官方模型页（ai.google.dev/gemini-api/docs/models，2026-10-14）：新增
 * gemini-4-argon / gemini-3.8-flash；移除文档已不再列出的 gemini-3.5-flash（存量会话由
 * 前端 normalizeCanvasModel 回退到默认模型，不会因 DTO 校验发不出消息）。
 */
export const CANVAS_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  // 注：gemini-3-pro-preview 已移除——该模型 ID 在 API 上恒 404（2026-08-25 实测 5/5 失败）
  'gemini-3-flash-preview',
  'deepseek:deepseek-flash',
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

/**
 * 画布节点类型：上传图片 / 上传视频 / 上传音频 / 生图 / 生视频 / 视频拼接。
 *
 * 曾经还有一个 `text` 节点专门承载提示词，生成节点靠入边去取。取消了：一次生成要摆两个
 * 节点连一条线，agent 规划和用户操作都多一层；而生成节点本来就有 prompt 字段，让它自己
 * 管自己的提示词，画布上少一类节点、少一半连线。
 *
 * ⚠️ 库里仍存在 type='text' 的历史行（未做数据迁移）。它们过不了 isCanvasNodeType，
 * 由快照层连同相关连线一起过滤掉（见 canvas.service 的 buildSnapshot），老画布照常打开。
 */
export type CanvasNodeType =
  | 'image_upload'
  | 'video_upload'
  | 'audio_upload'
  | 'image_gen'
  | 'video_gen'
  | 'video_concat';

export const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = [
  'image_upload',
  'video_upload',
  'audio_upload',
  'image_gen',
  'video_gen',
  'video_concat',
] as const;

export function isCanvasNodeType(v: unknown): v is CanvasNodeType {
  return (
    typeof v === 'string' &&
    (CANVAS_NODE_TYPES as readonly string[]).includes(v)
  );
}

/**
 * 节点端口上流动的资源类型。连线合法性与 outputs 形状都以它为单位。
 * 去掉 text 节点后没有任何节点再产出文本，故这里也不再有 'text'——提示词是生成节点
 * 自己的字段，不是端口上流动的资源。audio 只来自上传（画布没有生成音频的节点）。
 */
export type CanvasIoType = 'image' | 'video' | 'audio';

/** 上传节点：每种只收一类文件，输出类型固定（连线合法性因此仍能按节点类型静态判断）。 */
export type CanvasUploadNodeType =
  | 'image_upload'
  | 'video_upload'
  | 'audio_upload';

/** 上传节点 → 它收的资产类型（= 输出端口类型）。 */
export const UPLOAD_NODE_ASSET: Record<CanvasUploadNodeType, CanvasIoType> = {
  image_upload: 'image',
  video_upload: 'video',
  audio_upload: 'audio',
};

export function isUploadNodeType(v: string): v is CanvasUploadNodeType {
  return v in UPLOAD_NODE_ASSET;
}

/** 资产类型 → 收它的上传节点（agent 把附件摆上画布时按附件类型选节点）。 */
export function uploadNodeTypeFor(asset: CanvasIoType): CanvasUploadNodeType {
  if (asset === 'video') return 'video_upload';
  return asset === 'audio' ? 'audio_upload' : 'image_upload';
}

/**
 * 节点的一份输出。统一包成对象数组便于扩展——当前每个节点恒为 0 或 1 份。
 * content 恒为 MediaVersion.id（前端经带鉴权的 blob 接口取资产）。上传节点同样挂一个
 * MediaGeneration（model=upload），与生成节点共用 mediaGenerationId。
 * 早年 MVP 模拟上传的 image_upload 只存了 assetPath、没有版本，不产出任何输出。
 */
export interface CanvasNodeOutput {
  type: CanvasIoType;
  content: string;
}

/**
 * 每种节点的输入/输出契约（后端权威，前端在 canvas/_lib/node-io.ts 镜像）。
 * 入边数量不限（多输入），outputs 也是数组（多输出）——当前生成管线一次只产一份。
 *
 * 生成节点的提示词是它**自己的 prompt 字段**；入边提供参考素材（上游的 image / video / audio
 * 输出，按入边顺序）。各类型能收几个看模型目录的 image/video/audio_input_number，超出的部分
 * 在提交时丢掉（AigcService.submit），首帧模式的视频模型只取第一张图（MediaProcessor.loadRefUrls）。
 *
 * video_concat 是唯一**只吃视频**的节点：把多段上游视频按入边顺序接成一条。
 * 它不调生成模型，走本地 ffmpeg（见 media/video-concat.ts），但产出同样是一个
 * MediaVersion——于是状态流转、资产接口、下游引用与生成节点完全一致。
 */
export const CANVAS_NODE_IO: Record<
  CanvasNodeType,
  { inputs: readonly CanvasIoType[]; outputs: readonly CanvasIoType[] }
> = {
  image_upload: { inputs: [], outputs: ['image'] },
  video_upload: { inputs: [], outputs: ['video'] },
  audio_upload: { inputs: [], outputs: ['audio'] },
  image_gen: { inputs: ['image'], outputs: ['image'] },
  video_gen: { inputs: ['image', 'video', 'audio'], outputs: ['video'] },
  video_concat: { inputs: ['video'], outputs: ['video'] },
};

/**
 * 连线是否合法：source 的任一输出类型被 target 接受即可。
 * target 无输入端口（上传节点）→ 一律非法。
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
  /** 生成节点的提示词（image_gen / video_gen 自己的字段，不再来自上游节点）。 */
  prompt: string | null;
  assetPath: string | null;
  mediaGenerationId: string | null;
  /**
   * 生成节点选定的 aigc 渠道 / 模型别名 / 档位参数（image_gen、video_gen 专有）。
   * 三者都为空 = 用该类型的默认模型（aigc 目录里的第一个，见 aigc/aigc.catalog.ts）。
   */
  mediaChannel: string | null;
  mediaModel: string | null;
  mediaParams: Record<string, string> | null;
  /** 生成节点最新版本 id（JOIN 得出，供前端拉资产）。 */
  mediaVersionId: string | null;
  /** 生成节点最新状态：queued|generating|done|failed（JOIN 得出）。 */
  mediaStatus: string | null;
  /**
   * 该节点当前可供下游消费的输出（派生，不落表）。未就绪时为空数组：
   * 上传节点还没传文件、生成节点未 done 都是 []。
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

// 类型本体在 agent/token-usage（画布与 Spark 对话共用同一套会计口径），这里保留画布侧的名字
export type CanvasTokenTotals = TokenTotals;
export type CanvasTokenModelUsage = TokenModelUsage;
export type CanvasTokenCall = TokenCall;

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
  prompt?: string;
  assetPath?: string;
  /** 上传节点建时就挂上已有资产（agent 把对话附件摆上画布）。 */
  mediaGenerationId?: string;
  /** 生成节点建时就定好模型与档位（agent 的 add_node，已过 prepareNodeConfig 校验）。 */
  mediaChannel?: string;
  mediaModel?: string;
  mediaParams?: Record<string, string>;
}

export interface UpdateNodeOp {
  op: 'update_node';
  nodeId: string;
  label?: string;
  prompt?: string;
  assetPath?: string;
  mediaGenerationId?: string;
  /** 生成节点的模型选择（面板上改模型/档位时走这三个字段）。 */
  mediaChannel?: string;
  mediaModel?: string;
  mediaParams?: Record<string, string>;
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
 * 生成节点从**入边**拿到的素材：上游已就绪的 image / video / audio 输出（目标节点收哪些类型
 * 见 CANVAS_NODE_IO）。提示词是节点自己的 prompt 字段，不走入边。agent 工具与用户手动触发
 * 共用这一份，避免两条路各算各的、"agent 生成的和自己点生成的不一样"。
 */
export interface CanvasGenerationInputs {
  /** 参考素材的版本 id，按入边顺序（提示词里的 Image 1 / Image 2 靠的就是这个顺序）。 */
  referenceVersionIds: string[];
  /** 同上，按类型计数（给节点设模型时对照模型的各类素材上限）。 */
  referenceCounts: Record<CanvasIoType, number>;
  /** 连着但还没有产物的上游数（未生成完 / 还没传文件）：这次不参与生成。 */
  waitingInputs: number;
}

export function collectGenerationInputs(
  nodes: readonly CanvasNodeDto[],
  edges: readonly { source: string; target: string }[],
  nodeId: string,
): CanvasGenerationInputs {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const target = byId.get(nodeId);
  const accepted = target ? CANVAS_NODE_IO[target.type].inputs : [];
  // 按入边顺序（同 collectVideoSources），与前端附件栏的序号同源
  const upstream = edges
    .filter((e) => e.target === nodeId)
    .map((e) => byId.get(e.source))
    .filter((n): n is CanvasNodeDto => !!n);
  const refs = upstream.flatMap((n) =>
    n.outputs.filter((o) => accepted.includes(o.type)),
  );
  const referenceCounts = { image: 0, video: 0, audio: 0 };
  for (const o of refs) referenceCounts[o.type]++;
  return {
    referenceVersionIds: refs.map((o) => o.content),
    referenceCounts,
    waitingInputs: upstream.filter((n) => n.outputs.length === 0).length,
  };
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
