/**
 * 允许前端选择的回答模型白名单（单一事实来源，供 DTO 校验用）。
 * 标识符为 LangChain initChatModel 的 `provider:model` 形式（多提供商动态切换）；
 * 旧 DB 会话里的裸 `gemini-*` 名由 agent.factory 兼容回退到 google-genai。
 * 未传或非法值时，worker 回退到 env GOOGLE_GENAI_MODEL / 代码默认（见 agent.factory）。
 * 前端的下拉选项（含展示名）见 apps/frontend/src/app/agent/_lib/models.ts，改动需两边同步。
 */
export const ALLOWED_MODELS = [
  'google-genai:gemini-3.1-pro-preview',
  'google-genai:gemini-3.1-pro-preview-customtools',
  'google-genai:gemini-3.5-flash',
  'google-genai:gemini-3-flash-preview',
  'google-genai:gemini-3-pro-preview',
  'google-genai:gemini-2.5-pro',
  'google-genai:gemini-2.5-flash',
  'google-genai:gemini-flash-lite-latest',
  // DeepSeek：v4-* 为 /models API 列出的全部模型；chat/reasoner 为官方兼容别名（同样可调用）
  'deepseek:deepseek-v4-flash',
  'deepseek:deepseek-v4-pro',
  'deepseek:deepseek-chat',
  'deepseek:deepseek-reasoner',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];
