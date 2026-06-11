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
  { value: "google-genai:gemini-3.5-flash", hint: "快 · 默认" },
  { value: "google-genai:gemini-3-flash-preview", hint: "快 · Gemini 3 预览" },
  { value: "google-genai:gemini-3-pro-preview", hint: "强" },
  { value: "google-genai:gemini-3.1-pro-preview", hint: "最强" },
  { value: "google-genai:gemini-3.1-pro-preview-customtools", hint: "工具调用优化" },
  { value: "google-genai:gemini-2.5-pro", hint: "上一代旗舰" },
  { value: "google-genai:gemini-2.5-flash", hint: "上一代快档" },
  { value: "google-genai:gemini-flash-lite-latest", hint: "最快 · 最弱" },
  { value: "deepseek:deepseek-v4-flash", hint: "DeepSeek · V4 快档" },
  { value: "deepseek:deepseek-v4-pro", hint: "DeepSeek · V4 旗舰" },
  { value: "deepseek:deepseek-chat", hint: "DeepSeek · 通用对话（兼容别名）" },
  { value: "deepseek:deepseek-reasoner", hint: "DeepSeek · 深度推理（兼容别名）" },
];

export const DEFAULT_MODEL = "google-genai:gemini-3.5-flash";

/** 展示名：去掉 `provider:` 前缀，只展示模型名本身。 */
export function modelDisplayName(value: string): string {
  const i = value.indexOf(":");
  return i === -1 ? value : value.slice(i + 1);
}
