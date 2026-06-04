/**
 * 前端可选的回答模型下拉项。value 必须与后端白名单一致
 * （apps/backend/src/agent/models.ts 的 ALLOWED_MODELS），改动需两边同步。
 */
export interface ModelOption {
  /** 完整模型名（= 直接展示给用户，也是发给后端的值）。 */
  value: string;
  hint: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "gemini-3.5-flash", hint: "快 · 默认" },
  { value: "gemini-3-flash-preview", hint: "快 · Gemini 3 预览" },
  { value: "gemini-3-pro-preview", hint: "强" },
  { value: "gemini-3.1-pro-preview", hint: "最强" },
  { value: "gemini-3.1-pro-preview-customtools", hint: "工具调用优化" },
  { value: "gemini-2.5-pro", hint: "上一代旗舰" },
  { value: "gemini-2.5-flash", hint: "上一代快档" },
  { value: "gemini-flash-lite-latest", hint: "最快 · 最弱" },
];

export const DEFAULT_MODEL = "gemini-3.5-flash";
