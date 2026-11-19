import {
  type ThinkingLevel,
  thinkingLevelsFor,
  thinkingModelParams,
} from '../agent/thinking-level';
import type {
  ListedModel,
  ModelCapabilities,
  ProviderProtocol,
  ThinkingStyle,
} from './types';

/**
 * 模型能力的默认值：按协议 / 预设给思考参数写法，已知型号沿用现有实测结论（Gemini 哪些能关闭思考，
 * 见 agent/thinking-level.ts），接口给了上下文窗口就带上。用户可以在模型上逐个改，改过的以用户为准。
 */

/** 每种写法能提供的档位（auto = 不传思考参数，跟随模型默认） */
export function thinkingLevelsForStyle(
  style: ThinkingStyle,
  modelId: string,
): ThinkingLevel[] {
  switch (style) {
    case 'none':
      return ['auto'];
    case 'openai-effort':
    case 'openrouter':
    case 'anthropic':
      return ['auto', 'low', 'medium', 'high'];
    case 'thinking-type':
    case 'enable-thinking':
      return ['auto', 'off', 'on'];
    case 'gemini':
      // 复用实测矩阵：分级全模型可用，关闭只给实测支持的型号
      return thinkingLevelsFor(`google-genai:${modelId}`);
  }
}

/** OpenAI 官方：只有推理模型认 reasoning.effort（o 系列、gpt-5 系列） */
const OPENAI_REASONING = /^(o\d|gpt-5)/;
/** Claude 3.x（3.7 之前）不支持 extended thinking */
const CLAUDE_NO_THINKING = /^claude-3-(?!7)/;

export function defaultThinkingStyle(
  protocol: ProviderProtocol,
  presetStyle: ThinkingStyle,
  model: Pick<ListedModel, 'id' | 'thinking'>,
): ThinkingStyle {
  if (model.thinking === false) return 'none';
  switch (protocol) {
    case 'openai':
      return OPENAI_REASONING.test(model.id) ? 'openai-effort' : 'none';
    case 'anthropic':
      return CLAUDE_NO_THINKING.test(model.id) ? 'none' : 'anthropic';
    case 'gemini':
      return 'gemini';
    case 'openai-compatible':
      return presetStyle;
  }
}

export function defaultCapabilities(
  protocol: ProviderProtocol,
  presetStyle: ThinkingStyle,
  model: Pick<ListedModel, 'id' | 'thinking' | 'contextWindow'>,
): ModelCapabilities {
  const thinkingStyle = defaultThinkingStyle(protocol, presetStyle, model);
  return {
    thinkingStyle,
    thinkingLevels: thinkingLevelsForStyle(thinkingStyle, model.id),
    contextWindow: model.contextWindow,
  };
}

/** Anthropic 各档的思考预算与对应的 max_tokens（max_tokens 必须大于预算） */
const ANTHROPIC_BUDGET: Record<'low' | 'medium' | 'high', [number, number]> = {
  low: [2_048, 10_240],
  medium: [4_096, 12_288],
  high: [10_000, 16_000],
};
/** Anthropic 不开思考时的 max_tokens（Messages API 必填；8192 是 Claude 3.5 起都支持的上限） */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8_192;

/** 档位在该能力下不可选时一律按 auto（会话里可能存着换模型之前的档位） */
export function effectiveLevel(
  caps: ModelCapabilities,
  level: ThinkingLevel | null | undefined,
): ThinkingLevel {
  return level && caps.thinkingLevels.includes(level) ? level : 'auto';
}

/** 各协议构造参数里与思考有关的部分（见 build-model.ts） */
export type ThinkingParams =
  | { kind: 'none' }
  | { kind: 'openai'; effort: 'low' | 'medium' | 'high' }
  | { kind: 'model-kwargs'; modelKwargs: Record<string, unknown> }
  | { kind: 'anthropic'; budgetTokens: number; maxTokens: number }
  | { kind: 'gemini'; params: Record<string, unknown> };

export function thinkingParams(
  caps: ModelCapabilities,
  modelId: string,
  level: ThinkingLevel | null | undefined,
): ThinkingParams {
  const lv = effectiveLevel(caps, level);
  switch (caps.thinkingStyle) {
    case 'none':
      return { kind: 'none' };
    case 'openai-effort':
      return lv === 'low' || lv === 'medium' || lv === 'high'
        ? { kind: 'openai', effort: lv }
        : { kind: 'none' };
    case 'thinking-type':
      return lv === 'on' || lv === 'off'
        ? {
            kind: 'model-kwargs',
            modelKwargs: {
              thinking: { type: lv === 'on' ? 'enabled' : 'disabled' },
            },
          }
        : { kind: 'none' };
    case 'enable-thinking':
      return lv === 'on' || lv === 'off'
        ? {
            kind: 'model-kwargs',
            modelKwargs: { enable_thinking: lv === 'on' },
          }
        : { kind: 'none' };
    case 'openrouter':
      return lv === 'low' || lv === 'medium' || lv === 'high'
        ? { kind: 'model-kwargs', modelKwargs: { reasoning: { effort: lv } } }
        : { kind: 'none' };
    case 'anthropic': {
      if (lv !== 'low' && lv !== 'medium' && lv !== 'high')
        return { kind: 'none' };
      const [budgetTokens, maxTokens] = ANTHROPIC_BUDGET[lv];
      return { kind: 'anthropic', budgetTokens, maxTokens };
    }
    case 'gemini':
      return {
        kind: 'gemini',
        params: thinkingModelParams(`google-genai:${modelId}`, lv),
      };
  }
}
