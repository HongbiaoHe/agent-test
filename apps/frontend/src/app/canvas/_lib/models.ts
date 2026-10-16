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
    value: "gemini-4-argon",
    label: "Gemini 4 Argon",
    hint: "Google's flagship reasoning model",
    // 2026-10-14 实测：test/canvas-models.e2e.mjs 两次（各两轮真实 agent），第二轮命中 80% / 80%
    caps: {
      cache: "~80% hit, stable (2 of 2 runs)",
      thinking: "Low / Medium / High · can be turned off",
      notes: ["Slower: 25–90 s per turn in tests", GEMINI_THOUGHTS_NOTE],
    },
  },
  {
    value: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    hint: "Most capable Flash; Google's pick for new projects",
    // 2026-10-14 实测：canvas e2e 两次第二轮均 0% 命中（直连 API 探测有命中，画布里没触发）
    caps: {
      cache: "None — 0% in 2 of 2 runs",
      thinking: "Low / Medium / High · can be turned off",
      notes: ["No prompt caching in canvas runs — long sessions cost more", GEMINI_THOUGHTS_NOTE],
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

/**
 * 会话里存的模型已不在可选列表（模型下线/白名单更新）→ 回退默认模型。
 * 否则前端会把旧模型名发给后端，被 DTO 白名单拒绝（400），整个画布发不出消息。
 */
export function normalizeCanvasModel(value: string | null | undefined): string {
  return value && CANVAS_MODEL_OPTIONS.some((m) => m.value === value) ? value : DEFAULT_CANVAS_MODEL;
}

export function canvasModelLabel(value: string | null | undefined): string {
  if (!value) return CANVAS_MODEL_OPTIONS[0].label;
  return CANVAS_MODEL_OPTIONS.find((m) => m.value === value)?.label ?? value;
}

// 思考深度档位表已与 Spark agent 共用，移到 @/lib/thinking-level；这里转出，画布内引用不变。
export {
  type ThinkingLevel,
  type ThinkingLevelOption,
  supportsThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelsFor,
} from "@/lib/thinking-level";
