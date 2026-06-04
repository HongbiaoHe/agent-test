/**
 * 允许前端选择的回答模型白名单（单一事实来源，供 DTO 校验用）。
 * 未传或非法值时，worker 回退到 env GOOGLE_GENAI_MODEL / 代码默认（见 agent.factory）。
 * 前端的下拉选项（含展示名）见 apps/frontend/src/app/agent/_lib/models.ts，改动需两边同步。
 */
export const ALLOWED_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-flash-lite-latest',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];
