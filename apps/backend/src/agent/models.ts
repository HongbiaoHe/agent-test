/**
 * 允许前端选择的回答模型白名单（单一事实来源，供 DTO 校验用）。
 * 标识符为 LangChain initChatModel 的 `provider:model` 形式（多提供商动态切换）；
 * 旧 DB 会话里的裸 `gemini-*` 名由 agent.factory 兼容回退到 google-genai。
 * 未传或非法值时，worker 回退到 env GOOGLE_GENAI_MODEL / 代码默认（见 agent.factory）。
 * 前端的下拉选项（含展示名）见 apps/frontend/src/app/agent/_lib/models.ts，改动需两边同步。
 */
export const ALLOWED_MODELS = [
  // Gemini：按官方模型页（ai.google.dev/gemini-api/docs/models，2026-10-14）在列且实测
  // 工具调用可用的型号。已移除：gemini-3-pro-preview（官方已下线，实测 404）、
  // gemini-2.5-pro（对新用户 404）/ gemini-2.5-flash（官方注明仅限近期用户）、
  // 文档未列的 gemini-3.5-flash / -customtools / gemini-flash-lite-latest 别名。
  'google-genai:gemini-3.8-flash',
  'google-genai:gemini-4-argon',
  'google-genai:gemini-3.6-flash',
  'google-genai:gemini-3.5-flash-lite',
  'google-genai:gemini-3.1-flash-lite',
  'google-genai:gemini-3.1-pro-preview',
  'google-genai:gemini-3-flash-preview',
  // DeepSeek：官方 /models 与定价页只列这两个（2026-10-14）。deepseek-chat / deepseek-reasoner
  // 仍可调用但实测都由 deepseek-flash 应答，已不是独立模型，故移除。
  'deepseek:deepseek-flash',
  'deepseek:deepseek-v4-pro',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/**
 * 本次运行实际使用的模型标识：会话设置 → env GOOGLE_GENAI_MODEL → 代码默认。
 * agent.factory 装配模型与 worker 记 token 明细（provider 没回模型名时的回落值）共用这一个口径。
 */
export function resolveModelName(model?: string | null): string {
  return model ?? process.env.GOOGLE_GENAI_MODEL ?? 'gemini-3.8-flash';
}
