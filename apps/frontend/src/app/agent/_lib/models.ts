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
  { value: "google-genai:gemini-3.5-flash", hint: "Fast · default" },
  { value: "google-genai:gemini-3-flash-preview", hint: "Fast · Gemini 3 preview" },
  { value: "google-genai:gemini-3-pro-preview", hint: "Powerful" },
  { value: "google-genai:gemini-3.1-pro-preview", hint: "Most powerful" },
  { value: "google-genai:gemini-3.1-pro-preview-customtools", hint: "Tool-call optimized" },
  { value: "google-genai:gemini-2.5-pro", hint: "Previous-gen flagship" },
  { value: "google-genai:gemini-2.5-flash", hint: "Previous-gen fast tier" },
  { value: "google-genai:gemini-flash-lite-latest", hint: "Fastest · least capable" },
  { value: "deepseek:deepseek-v4-flash", hint: "DeepSeek · V4 fast tier" },
  { value: "deepseek:deepseek-v4-pro", hint: "DeepSeek · V4 flagship" },
  { value: "deepseek:deepseek-chat", hint: "DeepSeek · general chat (compat alias)" },
  { value: "deepseek:deepseek-reasoner", hint: "DeepSeek · deep reasoning (compat alias)" },
];

export const DEFAULT_MODEL = "google-genai:gemini-3.5-flash";

/** 展示名：去掉 `provider:` 前缀，只展示模型名本身。 */
export function modelDisplayName(value: string): string {
  const i = value.indexOf(":");
  return i === -1 ? value : value.slice(i + 1);
}
