/**
 * 思考深度档位的文案与收窄。每个模型能选哪些档位由它的能力决定（设置 → 模型里可改，
 * 见 agent-core providers/capabilities.ts），这里不再按模型名写死白名单。
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

/** 该模型可选的档位（来自模型能力 capabilities.thinkingLevels，顺序即展示顺序）→ 带文案的选项 */
export function thinkingOptions(levels: readonly ThinkingLevel[]): ThinkingLevelOption[] {
  return levels.map(option);
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return i18n.t(`agent.thinking.level.${level}`);
}

/** 任意字符串收窄成档位（本地存储/旧值可能非法），非法按 null。 */
export function asThinkingLevel(v: string | null | undefined): ThinkingLevel | null {
  return THINKING_LEVELS.find((l) => l === v) ?? null;
}
