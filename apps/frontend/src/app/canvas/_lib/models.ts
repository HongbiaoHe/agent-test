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
    hint: "Strongest 3.1. Most reliable at planning and finishing (default)",
  },
  {
    value: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    hint: "Light 3.1. Fast and cheap, weaker at following through",
  },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast 3.5, balanced" },
  {
    value: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    hint: "Light 3.5, cheapest",
  },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "Fast 3.6" },
  {
    value: "gemini-3-pro-preview",
    label: "Gemini 3.0 Pro",
    hint: "Strong 3.0, slower",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3.0 Flash",
    hint: "Fast 3.0",
  },
  {
    value: "deepseek:deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    hint: "Light DeepSeek, fast and cheap",
  },
  {
    value: "deepseek:deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    hint: "Flagship DeepSeek, stronger reasoning",
  },
];

export const DEFAULT_CANVAS_MODEL = CANVAS_MODEL_OPTIONS[0].value;

export function canvasModelLabel(value: string | null | undefined): string {
  if (!value) return CANVAS_MODEL_OPTIONS[0].label;
  return CANVAS_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value;
}
