/**
 * 前端可选的回答模型下拉项。value 必须与后端白名单一致
 * （apps/backend/src/agent/models.ts 的 ALLOWED_MODELS），改动需两边同步。
 * value 为 LangChain initChatModel 的 `provider:model` 形式（多提供商动态切换）。
 */
export interface ModelOption {
  /** `provider:model` 完整标识（发给后端的值）。 */
  value: string;
  hint: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "google-genai:gemini-3.8-flash", hint: "Fast · default" },
  { value: "google-genai:gemini-4-argon", hint: "Most powerful · flagship" },
  { value: "google-genai:gemini-3.6-flash", hint: "Previous-gen Flash" },
  { value: "google-genai:gemini-3.5-flash-lite", hint: "Fastest · lowest cost" },
  { value: "google-genai:gemini-3.1-flash-lite", hint: "Low cost · near-frontier" },
  { value: "google-genai:gemini-3.1-pro-preview", hint: "Previous-gen Pro · preview" },
  { value: "google-genai:gemini-3-flash-preview", hint: "Gemini 3 Flash · preview" },
  { value: "deepseek:deepseek-flash", hint: "DeepSeek V4.1 Flash · fast" },
  { value: "deepseek:deepseek-v4-pro", hint: "DeepSeek V4 Pro · flagship" },
];

export const DEFAULT_MODEL = "google-genai:gemini-3.8-flash";

/** 展示名：去掉 `provider:` 前缀，只展示模型名本身。 */
export function modelDisplayName(value: string): string {
  const i = value.indexOf(":");
  return i === -1 ? value : value.slice(i + 1);
}
