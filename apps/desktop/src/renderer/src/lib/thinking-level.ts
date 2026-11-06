/**
 * 思考深度档位（Spark agent 与画布共用）。与后端 `apps/backend/src/agent/thinking-level.ts` 的
 * THINKING_LEVELS 一一对应，改动需两边同步。
 *
 * 各家能力**不对等**（后端实测结论，详见后端 thinking-level.ts 的矩阵）：
 * - DeepSeek 只有开/关两态（OpenAI 风格的 reasoningEffort 对它无效，点了没反应）
 * - Gemini 的 低/中/高 全模型可用，但**关闭**（thinkingBudget:0）只有部分模型接受，
 *   其余会 400 Bad Request —— 所以 off 档只给白名单内的模型。
 *
 * 模型标识既可能是 `provider:model`（Spark）也可能是裸名（画布），这里统一去前缀再判断。
 */
import { i18n } from "@/lib/i18n";

export type ThinkingLevel = "auto" | "off" | "on" | "low" | "medium" | "high";

export interface ThinkingLevelOption {
  value: ThinkingLevel;
  label: string;
  hint: string;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "off", "on", "low", "medium", "high"];

/** 文案在调用时取（界面语言可能在运行中切换） */
function option(value: ThinkingLevel): ThinkingLevelOption {
  return {
    value,
    label: i18n.t(`agent.thinking.level.${value}`),
    hint: i18n.t(`agent.thinking.hint.${value}`),
  };
}

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
  "gemini-3.8-flash",
  "gemini-4-argon",
]);

function bareModelName(model: string): string {
  const i = model.indexOf(":");
  return i === -1 ? model : model.slice(i + 1);
}

/** 该模型真正支持的档位（顺序即展示顺序）。 */
export function thinkingLevelsFor(model: string): ThinkingLevelOption[] {
  if (model.startsWith("deepseek:")) {
    return DEEPSEEK_LEVELS.map(option);
  }
  const levels = GEMINI_CAN_DISABLE_THINKING.has(bareModelName(model))
    ? GEMINI_LEVELS_WITH_OFF
    : GEMINI_LEVELS;
  return levels.map(option);
}

/** 档位在该模型上是否可用——换模型后用它决定要不要把选择回落到 auto。 */
export function supportsThinkingLevel(
  model: string,
  level: ThinkingLevel,
): boolean {
  return thinkingLevelsFor(model).some((o) => o.value === level);
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return i18n.t(`agent.thinking.level.${level}`);
}

/** 任意字符串收窄成档位（本地存储/旧值可能非法），非法按 null。 */
export function asThinkingLevel(v: string | null | undefined): ThinkingLevel | null {
  return THINKING_LEVELS.find((l) => l === v) ?? null;
}
