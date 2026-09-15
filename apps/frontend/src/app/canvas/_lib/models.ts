/**
 * 画布 agent 可选模型（Gemini 系可对话模型）。与后端 CANVAS_MODELS 白名单保持一致
 * （apps/backend/src/canvas/canvas.types.ts）。均为 google-genai 裸模型名。
 */
/**
 * 模型实测能力（hover 模型选项时在右侧 tooltip 展示）。
 *
 * 数据来自 2026-08-25 的 e2e 回归：canvas 白名单里每个模型 × 每个思考档位各建一个独立会话，
 * 跑两轮真实 agent（含工具调用），用第二轮量 prompt cache 命中率。
 * ⚠️ 这些数字反映 provider 当时的行为，会过期；改模型白名单或怀疑数字不准时应重测。
 */
export interface CanvasModelCaps {
  /** prompt cache 表现 */
  cache: string;
  /** 思考深度支持情况 */
  thinking: string;
  /** 需要提醒用户的已知问题（不可用 / 超时 / 不缓存 / 思考不可见等） */
  notes?: string[];
}

export interface CanvasModelOption {
  value: string;
  label: string;
  hint: string;
  caps: CanvasModelCaps;
}

/** Gemini 全系共有的限制：思考正文当前在界面上显示不出来（后端 normalizer 只认 DeepSeek 字段）。 */
const GEMINI_THOUGHTS_NOTE = "Thought text not shown in UI yet";

export const CANVAS_MODEL_OPTIONS: CanvasModelOption[] = [
  {
    value: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    hint: "Strongest 3.1. Most reliable at planning and finishing (default)",
    caps: {
      cache: "~41% hit, stable · 2048-token block granularity",
      thinking: "Low / Medium / High · cannot be turned off",
      notes: [GEMINI_THOUGHTS_NOTE],
    },
  },
  {
    value: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    hint: "Light 3.1. Fast and cheap, weaker at following through",
    caps: {
      cache: "20–54% hit, unstable",
      thinking: "Low / Medium / High · can be turned off",
      notes: [GEMINI_THOUGHTS_NOTE],
    },
  },
  {
    value: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    hint: "Fast 3.5, balanced",
    caps: {
      cache: "0–76% hit, highly variable",
      thinking: "Low / Medium / High · can be turned off",
      notes: [GEMINI_THOUGHTS_NOTE],
    },
  },
  {
    value: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    hint: "Light 3.5, cheapest",
    caps: {
      cache: "None — 0% across all 5 runs",
      thinking: "Low / Medium / High · cannot be turned off",
      notes: [
        "No prompt caching at all — long sessions cost much more",
        GEMINI_THOUGHTS_NOTE,
      ],
    },
  },
  {
    value: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    hint: "Fast 3.6",
    caps: {
      cache: "~40% hit, stable",
      thinking: "Low / Medium / High · cannot be turned off",
      notes: [GEMINI_THOUGHTS_NOTE],
    },
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3.0 Flash",
    hint: "Fast 3.0",
    caps: {
      cache: "Barely caches — 0% in 4 of 5 runs",
      thinking: "Low / Medium / High · can be turned off",
      notes: [
        "Often exceeds 120s and times out mid-run",
        GEMINI_THOUGHTS_NOTE,
      ],
    },
  },
  {
    value: "deepseek:deepseek-flash",
    label: "DeepSeek Flash",
    hint: "Light DeepSeek, fast and cheap",
    caps: {
      cache: "~98% hit — best in class",
      thinking: "On / Off only, no levels",
    },
  },
  {
    value: "deepseek:deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    hint: "Flagship DeepSeek, stronger reasoning",
    caps: {
      cache: "~97% hit — best in class",
      thinking: "On / Off only, no levels",
    },
  },
];

export const DEFAULT_CANVAS_MODEL = CANVAS_MODEL_OPTIONS[0].value;

export function canvasModelLabel(value: string | null | undefined): string {
  if (!value) return CANVAS_MODEL_OPTIONS[0].label;
  return CANVAS_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value;
}

/**
 * 思考深度档位。与后端 `canvas/thinking-level.ts` 的 CANVAS_THINKING_LEVELS 一一对应，
 * 改动需两边同步。
 *
 * 各家能力**不对等**（后端实测结论，详见 backend/src/canvas/thinking-level.ts 的矩阵）：
 * - DeepSeek 只有开/关两态（OpenAI 风格的 reasoningEffort 对它无效，点了没反应）
 * - Gemini 的 低/中/高 全模型可用，但**关闭**（thinkingBudget:0）只有部分模型接受，
 *   其余会 400 Bad Request —— 所以 off 档只给白名单内的模型。
 *
 * ⚠️ Gemini 目前拿不到思考正文（@langchain/google-genai 2.1.31 不暴露 thought 块），
 * 思考过程面板在 Gemini 上是空的；档位仍然影响它思考多少。
 *
 * 这张表须与后端 thinking-level.ts 保持一致，改动需两边同步。
 */
export type ThinkingLevel = "auto" | "off" | "on" | "low" | "medium" | "high";

export interface ThinkingLevelOption {
  value: ThinkingLevel;
  label: string;
  hint: string;
}

const THINKING_OPTION: Record<ThinkingLevel, ThinkingLevelOption> = {
  auto: { value: "auto", label: "Auto", hint: "Model default, unchanged" },
  off: { value: "off", label: "Off", hint: "No thinking. Fastest and cheapest" },
  on: { value: "on", label: "On", hint: "Think before answering" },
  low: { value: "low", label: "Low", hint: "Brief thinking" },
  medium: { value: "medium", label: "Medium", hint: "Balanced thinking" },
  high: { value: "high", label: "High", hint: "Deepest thinking, slowest" },
};

const DEEPSEEK_LEVELS: ThinkingLevel[] = ["auto", "off", "on"];
const GEMINI_LEVELS: ThinkingLevel[] = ["auto", "low", "medium", "high"];
const GEMINI_LEVELS_WITH_OFF: ThinkingLevel[] = [
  "auto",
  "off",
  "low",
  "medium",
  "high",
];

/** 实测接受 thinkingBudget:0 的 Gemini 模型；其余传 0 会 400。与后端白名单一致。 */
const GEMINI_CAN_DISABLE_THINKING = new Set([
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
]);

function bareModelName(model: string): string {
  const i = model.indexOf(":");
  return i === -1 ? model : model.slice(i + 1);
}

/** 该模型真正支持的档位（顺序即展示顺序）。 */
export function thinkingLevelsFor(model: string): ThinkingLevelOption[] {
  if (model.startsWith("deepseek:")) {
    return DEEPSEEK_LEVELS.map((l) => THINKING_OPTION[l]);
  }
  const levels = GEMINI_CAN_DISABLE_THINKING.has(bareModelName(model))
    ? GEMINI_LEVELS_WITH_OFF
    : GEMINI_LEVELS;
  return levels.map((l) => THINKING_OPTION[l]);
}

/** 档位在该模型上是否可用——换模型后用它决定要不要把选择回落到 auto。 */
export function supportsThinkingLevel(
  model: string,
  level: ThinkingLevel,
): boolean {
  return thinkingLevelsFor(model).some((o) => o.value === level);
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_OPTION[level]?.label ?? THINKING_OPTION.auto.label;
}
