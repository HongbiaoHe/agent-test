import {
  type AgentMode,
  AgentModeSchema,
  GENERAL_MODE_PROMPT,
} from '@agent-test/agent-core/modes/mode.schema';
import {
  type FragmentOverrides,
  PROMPT_FRAGMENT_DEFAULTS,
  type PromptFragmentId,
} from '@agent-test/agent-core/modes/prompt-fragments';
import type {
  AgentMode as AgentModeRow,
  CustomPromptFragment,
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

/**
 * GET /modes/fragments 单项、POST / PUT /modes/fragments 的返回形状。
 * kind 区分内置（platform.*，可改写 / 恢复默认，不能删）与用户自建（custom.*，可改 title / 正文、可删）。
 * isCustom 沿用旧语义「内置片段是否被改写过」，自建片段恒为 false。
 */
export type PromptFragmentView =
  | {
      kind: 'builtin';
      id: PromptFragmentId;
      /** 内置片段没有显示名 */
      title: null;
      /** 生效的正文：用户改写的，没改写则是默认 */
      text: string;
      defaultText: string;
      isCustom: boolean;
    }
  | {
      kind: 'custom';
      id: string;
      title: string;
      text: string;
      /** 自建片段没有默认正文可恢复 */
      defaultText: null;
      isCustom: false;
    };

export function toFragmentView(
  id: PromptFragmentId,
  overrides: FragmentOverrides,
): PromptFragmentView {
  const custom = overrides[id];
  return {
    kind: 'builtin',
    id,
    title: null,
    text: custom ?? PROMPT_FRAGMENT_DEFAULTS[id],
    defaultText: PROMPT_FRAGMENT_DEFAULTS[id],
    isCustom: custom !== undefined,
  };
}

export function toCustomFragmentView(
  row: Pick<CustomPromptFragment, 'fragmentId' | 'title' | 'text'>,
): PromptFragmentView {
  return {
    kind: 'custom',
    id: row.fragmentId,
    title: row.title,
    text: row.text,
    defaultText: null,
    isCustom: false,
  };
}
