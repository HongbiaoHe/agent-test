/**
 * 画布 agent 可选模型（Gemini 系可对话模型）。与后端 CANVAS_MODELS 白名单保持一致
 * （apps/backend/src/canvas/canvas.types.ts）。均为 google-genai 裸模型名。
 */
export interface CanvasModelOption {
  value: string;
  label: string;
  hint: string;
}

export const CANVAS_MODEL_OPTIONS: CanvasModelOption[] = [
  {
    value: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    hint: "3.1 最强，规划/执行到底最可靠（默认）",
  },
  {
    value: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    hint: "3.1 轻量，快而省，执行力偏弱",
  },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "3.5 快，均衡" },
  {
    value: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    hint: "3.5 轻量，最省",
  },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "3.6 快" },
  {
    value: "gemini-3-pro-preview",
    label: "Gemini 3.0 Pro",
    hint: "3.0 强，较慢",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3.0 Flash",
    hint: "3.0 快",
  },
  {
    value: "deepseek:deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    hint: "DeepSeek 轻量，快而省",
  },
  {
    value: "deepseek:deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    hint: "DeepSeek 旗舰，推理更强",
  },
];

export const DEFAULT_CANVAS_MODEL = CANVAS_MODEL_OPTIONS[0].value;

export function canvasModelLabel(value: string | null | undefined): string {
  if (!value) return CANVAS_MODEL_OPTIONS[0].label;
  return CANVAS_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value;
}
