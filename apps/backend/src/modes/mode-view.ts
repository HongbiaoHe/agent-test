import {
  type AgentMode,
  AgentModeSchema,
  GENERAL_MODE_PROMPT,
} from '@agent-test/agent-core/modes/mode.schema';
import type {
  AgentMode as AgentModeRow,
  GeneralModeSetting,
} from '@prisma/client';

/** 把 Prisma 行收窄成 core 的 AgentMode（Json 列 → string[]），worker 与 API 共用。 */
export function toAgentMode(row: AgentModeRow): AgentMode {
  return AgentModeSchema.parse(row);
}

/** API 返回形状：core 字段 + 时间戳（不透出 userId）。 */
export type AgentModeView = AgentMode & { createdAt: Date; updatedAt: Date };

export function toModeView(row: AgentModeRow): AgentModeView {
  return {
    ...toAgentMode(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** GET/PUT /modes/general 的返回形状：生效的提示词（自定义或默认）+ 是否自定义 + 默认提示词。 */
export interface GeneralModeView {
  systemPrompt: string;
  isCustom: boolean;
  defaultPrompt: string;
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
}

/** 没有行 = 全部默认。 */
export function toGeneralModeView(
  row: GeneralModeSetting | null,
): GeneralModeView {
  return {
    systemPrompt: row?.systemPrompt ?? GENERAL_MODE_PROMPT,
    isCustom: row?.systemPrompt != null,
    defaultPrompt: GENERAL_MODE_PROMPT,
    defaultModel: row?.defaultModel ?? null,
    defaultThinkingLevel: row?.defaultThinkingLevel ?? null,
  };
}
