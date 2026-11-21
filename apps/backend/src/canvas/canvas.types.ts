/**
 * 画布领域类型：共享部分（节点 / 连线 / 操作 / 增量 / 连线规则 / 上游收集）在 @agent-test/canvas-schema，
 * 后端、web、desktop 三方共用同一份；这里转出它们，并只保留后端专有的定义（画布 agent 模型白名单、
 * token 报表、token_usage 事件）。
 *
 * 设计见 docs/superpowers/specs/2026-07-22-canvas-workflow-agent-design.md：
 * 服务端单一真相源、客户端为投影——所有结构变更经 CanvasService.applyOp 事务化写入
 * （物化表 + CanvasOp 日志 + revision）并广播 canvas_patch。
 */

export * from '@agent-test/canvas-schema';

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

/** token_usage 事件 payload（只推流，不落 CanvasMessage）：本次调用增量 + 运行累计。 */
export interface TokenUsagePayload {
  runId: string;
  model: string;
  input: number;
  output: number;
  total: number;
  cumulativeTotal: number;
}
