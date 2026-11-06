/**
 * 前端可选的回答模型下拉项。value 必须与后端白名单一致
 * （apps/backend/src/agent/models.ts 的 ALLOWED_MODELS），改动需两边同步。
 * value 为 LangChain initChatModel 的 `provider:model` 形式（多提供商动态切换）。
 */
import type { chat } from "../../../../../shared/i18n/zh-CN/chat";

export interface ModelOption {
  /** `provider:model` 完整标识（发给后端的值）。 */
  value: string;
  /** 说明文案的字典键（chat.modelHint.*） */
  hint: keyof typeof chat.modelHint;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "google-genai:gemini-3.8-flash", hint: "gemini38Flash" },
  { value: "google-genai:gemini-4-argon", hint: "gemini4Argon" },
  { value: "google-genai:gemini-3.6-flash", hint: "gemini36Flash" },
  { value: "google-genai:gemini-3.5-flash-lite", hint: "gemini35FlashLite" },
  { value: "google-genai:gemini-3.1-flash-lite", hint: "gemini31FlashLite" },
  { value: "google-genai:gemini-3.1-pro-preview", hint: "gemini31ProPreview" },
  { value: "google-genai:gemini-3-flash-preview", hint: "gemini3FlashPreview" },
  { value: "deepseek:deepseek-flash", hint: "deepseekFlash" },
  { value: "deepseek:deepseek-v4-pro", hint: "deepseekV4Pro" },
];

export const DEFAULT_MODEL = "google-genai:gemini-3.8-flash";

/** 展示名：去掉 `provider:` 前缀，只展示模型名本身。 */
export function modelDisplayName(value: string): string {
  const i = value.indexOf(":");
  return i === -1 ? value : value.slice(i + 1);
}
