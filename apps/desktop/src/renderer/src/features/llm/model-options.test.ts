import { describe, expect, it } from 'vitest';
import {
  filterModels,
  groupByConnection,
  groupPresets,
  isHttpUrl,
  modelIdOfRef,
  protocolKey,
  thinkingStyleKey,
  translatedPresetKey,
  usageModelLabel,
} from './model-options';

const opt = (connectionId: string, connectionName: string, modelId: string, displayName: string | null = null) => ({
  connectionId,
  connectionName,
  modelId,
  displayName,
});

describe('groupByConnection', () => {
  it('按连接分组，组序与组内顺序沿用输入', () => {
    const groups = groupByConnection([
      opt('c1', 'Gemini', 'gemini-a'),
      opt('c2', 'DeepSeek', 'deepseek-chat'),
      opt('c1', 'Gemini', 'gemini-b'),
    ]);
    expect(groups.map((g) => g.connectionName)).toEqual(['Gemini', 'DeepSeek']);
    expect(groups[0].models.map((m) => m.modelId)).toEqual(['gemini-a', 'gemini-b']);
    expect(groups[1].models.map((m) => m.modelId)).toEqual(['deepseek-chat']);
  });

  it('空列表 → 没有分组', () => {
    expect(groupByConnection([])).toEqual([]);
  });
});

describe('filterModels', () => {
  const list = [
    opt('c1', 'OpenRouter', 'anthropic/claude-sonnet-4', 'Claude Sonnet 4'),
    opt('c1', 'OpenRouter', 'openai/gpt-5'),
    opt('c2', 'Gemini', 'gemini-3.8-flash'),
  ];

  it('空查询返回全部（新数组）', () => {
    const out = filterModels(list, '  ');
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('不区分大小写，匹配模型 id / 展示名 / 连接名', () => {
    expect(filterModels(list, 'GEMINI').map((m) => m.modelId)).toEqual(['gemini-3.8-flash']);
    expect(filterModels(list, 'sonnet').map((m) => m.modelId)).toEqual(['anthropic/claude-sonnet-4']);
    expect(filterModels(list, 'openrouter').length).toBe(2);
  });

  it('多个词须同时命中', () => {
    expect(filterModels(list, 'openai gpt').map((m) => m.modelId)).toEqual(['openai/gpt-5']);
    expect(filterModels(list, 'openai claude')).toEqual([]);
  });
});

describe('modelIdOfRef / usageModelLabel', () => {
  it('引用按第一个 / 切开，模型 id 自身可以带 / 与 :', () => {
    expect(modelIdOfRef('conn-1/anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(modelIdOfRef('conn-1/llama3:8b')).toBe('llama3:8b');
  });

  it('旧版 provider:model 去掉前缀；空值为空串', () => {
    expect(modelIdOfRef('google-genai:gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(modelIdOfRef(null)).toBe('');
    expect(modelIdOfRef('')).toBe('');
  });

  it('token 报表的模型名不按引用切（OpenRouter 模型名本身带 /）', () => {
    expect(usageModelLabel('anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(usageModelLabel('deepseek:deepseek-flash')).toBe('deepseek-flash');
    expect(usageModelLabel('llama3:8b')).toBe('llama3:8b');
  });
});

describe('groupPresets', () => {
  it('官方协议在前（OpenAI、Anthropic、Gemini），OpenAI 兼容在后且含 DeepSeek / Ollama / 自定义', () => {
    const groups = groupPresets();
    expect(groups.map((g) => g.key)).toEqual(['official', 'compatible']);
    expect(groups[0].presets.map((p) => p.id)).toEqual(['openai', 'anthropic', 'gemini']);
    const compatible = groups[1].presets.map((p) => p.id);
    expect(compatible[0]).toBe('deepseek');
    expect(compatible).toEqual(expect.arrayContaining(['dashscope', 'zhipu', 'openrouter', 'ollama', 'lmstudio']));
    expect(compatible.at(-1)).toBe('custom');
  });

  it('Ollama 预设：本地地址、不要求 Key', () => {
    const ollama = groupPresets()[1].presets.find((p) => p.id === 'ollama');
    expect(ollama?.baseUrl).toBe('http://localhost:11434/v1');
    expect(ollama?.keyRequired).toBe(false);
  });
});

describe('字典键映射', () => {
  it('只有中文名的预设需要翻译', () => {
    expect(translatedPresetKey('custom')).toBe('custom');
    expect(translatedPresetKey('dashscope')).toBe('dashscope');
    expect(translatedPresetKey('openai')).toBeNull();
  });

  it('协议与思考写法转成字典键', () => {
    expect(protocolKey('openai-compatible')).toBe('openaiCompatible');
    expect(protocolKey('gemini')).toBe('gemini');
    expect(thinkingStyleKey('enable-thinking')).toBe('enableThinking');
    expect(thinkingStyleKey('none')).toBe('none');
  });
});

describe('isHttpUrl', () => {
  it('只接受 http(s) 地址', () => {
    expect(isHttpUrl('http://localhost:11434/v1')).toBe(true);
    expect(isHttpUrl(' https://api.openai.com/v1 ')).toBe(true);
    expect(isHttpUrl('ftp://x.y')).toBe(false);
    expect(isHttpUrl('api.openai.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});
