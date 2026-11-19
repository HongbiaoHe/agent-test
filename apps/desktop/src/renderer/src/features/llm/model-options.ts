/**
 * 模型下拉 / 模型列表的纯逻辑：按连接分组、搜索过滤、从引用里取展示用的模型 id、连接预设分组。
 * 不依赖 React，便于单测（model-options.test.ts）。
 */
import { parseModelRef } from '@agent-test/agent-core/providers/model-ref';
import { PROVIDER_PRESETS, type ProviderPreset } from '@agent-test/agent-core/providers/presets';
import type { ProviderProtocol, ThinkingStyle } from '@agent-test/agent-core/providers/types';

export interface ModelGroup<T> {
  connectionId: string;
  connectionName: string;
  models: T[];
}

/** 按连接分组，组的顺序与组内顺序都沿用输入顺序（host 已按连接创建时间、模型 id 排好） */
export function groupByConnection<T extends { connectionId: string; connectionName: string }>(
  options: readonly T[],
): ModelGroup<T>[] {
  const groups = new Map<string, ModelGroup<T>>();
  for (const o of options) {
    const g = groups.get(o.connectionId);
    if (g) g.models.push(o);
    else groups.set(o.connectionId, { connectionId: o.connectionId, connectionName: o.connectionName, models: [o] });
  }
  return [...groups.values()];
}

/** 不区分大小写、按空白切词，每个词都要命中模型 id / 展示名 / 连接名之一 */
export function filterModels<T extends { modelId: string; displayName: string | null; connectionName?: string }>(
  models: readonly T[],
  query: string,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = [m.modelId, m.displayName ?? '', m.connectionName ?? ''].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 升级前的模型串是 `provider:model`（google-genai / deepseek）；迁移后会改写成引用，这里只为显示兜底 */
const LEGACY_PREFIX = /^(google-genai|deepseek):/;

/** 引用「连接 id/模型 id」→ 模型 id；不是引用（旧值）时去掉旧的 provider 前缀原样显示 */
export function modelIdOfRef(ref: string | null | undefined): string {
  if (!ref) return '';
  return parseModelRef(ref)?.modelId ?? ref.replace(LEGACY_PREFIX, '');
}

/** token 报表里的模型名是服务端返回的裸模型名（OpenRouter 的会带 `/`），只去掉旧版前缀 */
export function usageModelLabel(name: string): string {
  return name.replace(LEGACY_PREFIX, '');
}

export type PresetGroupKey = 'official' | 'compatible';

/** 添加连接时的预设分组：官方协议（OpenAI / Anthropic / Gemini）在前，OpenAI 兼容的在后（含「自定义」） */
export function groupPresets(
  presets: readonly ProviderPreset[] = PROVIDER_PRESETS,
): { key: PresetGroupKey; presets: ProviderPreset[] }[] {
  const official = presets.filter((p) => p.protocol !== 'openai-compatible');
  const compatible = presets.filter((p) => p.protocol === 'openai-compatible');
  return [
    { key: 'official' as const, presets: official },
    { key: 'compatible' as const, presets: compatible },
  ].filter((g) => g.presets.length > 0);
}

/** 预设名里需要翻译的几个（其余是品牌名，原样显示）→ 字典 settings.models.presetNames.* */
const TRANSLATED_PRESETS = ['dashscope', 'zhipu', 'siliconflow', 'custom'] as const;
export type TranslatedPreset = (typeof TRANSLATED_PRESETS)[number];

export function translatedPresetKey(presetId: string): TranslatedPreset | null {
  return TRANSLATED_PRESETS.find((p) => p === presetId) ?? null;
}

/** 协议 → 字典 settings.models.protocol.* 的键 */
export function protocolKey(protocol: ProviderProtocol): 'openai' | 'openaiCompatible' | 'anthropic' | 'gemini' {
  return protocol === 'openai-compatible' ? 'openaiCompatible' : protocol;
}

/** 思考写法 → 字典 settings.models.capabilities.style.* 的键 */
export function thinkingStyleKey(
  style: ThinkingStyle,
): 'none' | 'openaiEffort' | 'thinkingType' | 'enableThinking' | 'openrouter' | 'anthropic' | 'gemini' {
  switch (style) {
    case 'openai-effort':
      return 'openaiEffort';
    case 'thinking-type':
      return 'thinkingType';
    case 'enable-thinking':
      return 'enableThinking';
    default:
      return style;
  }
}

/** Base URL 输入校验：必须是 http(s) 地址（host 侧还会用 z.url() 再校验一次） */
export function isHttpUrl(value: string): boolean {
  const v = value.trim();
  if (!URL.canParse(v)) return false;
  const { protocol } = new URL(v);
  return protocol === 'http:' || protocol === 'https:';
}
