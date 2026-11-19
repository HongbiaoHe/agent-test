import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import {
  buildChatModel,
  keepsNativeBlocksFor,
  normalizeBaseUrl,
} from './build-model';
import {
  defaultCapabilities,
  effectiveLevel,
  thinkingLevelsForStyle,
  thinkingParams,
} from './capabilities';
import { listModels, ProviderHttpError } from './list-models';
import { modelRef, parseModelRef } from './model-ref';
import { findPreset, PROVIDER_PRESETS } from './presets';
import { testConnection, testModel } from './test-model';
import type { ModelCapabilities, ProviderConnection } from './types';

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  thinkingStyle: 'none',
  thinkingLevels: ['auto'],
  contextWindow: null,
  ...over,
});

describe('presets', () => {
  it('14 个预设：3 个官方协议 + 10 个 OpenAI 兼容 + 自定义；本地服务不要 Key', () => {
    expect(PROVIDER_PRESETS).toHaveLength(14);
    expect(
      PROVIDER_PRESETS.filter((p) => p.protocol === 'openai-compatible'),
    ).toHaveLength(11);
    expect(findPreset('ollama')?.keyRequired).toBe(false);
    expect(findPreset('deepseek')?.thinkingStyle).toBe('thinking-type');
    expect(findPreset('nope')).toBeNull();
  });
});

describe('capabilities', () => {
  it('默认思考写法：OpenAI 只有推理模型、Claude 3.x（3.7 前）不支持、兼容服务跟预设、接口说不支持就是 none', () => {
    const d = (
      p: Parameters<typeof defaultCapabilities>[0],
      id: string,
      thinking: boolean | null = null,
    ) =>
      defaultCapabilities(p, 'enable-thinking', {
        id,
        thinking,
        contextWindow: null,
      }).thinkingStyle;
    expect(d('openai', 'gpt-5.1')).toBe('openai-effort');
    expect(d('openai', 'o4-mini')).toBe('openai-effort');
    expect(d('openai', 'gpt-4o')).toBe('none');
    expect(d('anthropic', 'claude-sonnet-4-5')).toBe('anthropic');
    expect(d('anthropic', 'claude-3-5-haiku-latest')).toBe('none');
    expect(d('anthropic', 'claude-3-7-sonnet-latest')).toBe('anthropic');
    expect(d('openai-compatible', 'qwen3-max')).toBe('enable-thinking');
    expect(d('gemini', 'gemini-2.0-flash', false)).toBe('none');
  });

  it('档位：Gemini 沿用实测矩阵（能关闭的才有 off）；开关类只有 off/on；不可选的档位回落 auto', () => {
    expect(thinkingLevelsForStyle('gemini', 'gemini-3.8-flash')).toContain(
      'off',
    );
    expect(thinkingLevelsForStyle('gemini', 'gemini-3.6-flash')).not.toContain(
      'off',
    );
    expect(thinkingLevelsForStyle('thinking-type', 'x')).toEqual([
      'auto',
      'off',
      'on',
    ]);
    expect(
      effectiveLevel(caps({ thinkingLevels: ['auto', 'on'] }), 'high'),
    ).toBe('auto');
  });

  it('各写法的参数：DeepSeek/智谱 thinking.type、通义 enable_thinking、OpenRouter reasoning.effort、Anthropic 预算 < max_tokens', () => {
    const levels = (style: ModelCapabilities['thinkingStyle']) =>
      caps({
        thinkingStyle: style,
        thinkingLevels: thinkingLevelsForStyle(style, 'm'),
      });
    expect(thinkingParams(levels('thinking-type'), 'm', 'off')).toEqual({
      kind: 'model-kwargs',
      modelKwargs: { thinking: { type: 'disabled' } },
    });
    expect(thinkingParams(levels('enable-thinking'), 'm', 'on')).toEqual({
      kind: 'model-kwargs',
      modelKwargs: { enable_thinking: true },
    });
    expect(thinkingParams(levels('openrouter'), 'm', 'high')).toEqual({
      kind: 'model-kwargs',
      modelKwargs: { reasoning: { effort: 'high' } },
    });
    const a = thinkingParams(levels('anthropic'), 'm', 'high');
    expect(a.kind === 'anthropic' && a.budgetTokens < a.maxTokens).toBe(true);
    expect(thinkingParams(levels('openai-effort'), 'm', 'auto')).toEqual({
      kind: 'none',
    });
  });
});

describe('buildChatModel', () => {
  const conn = (
    protocol: ProviderConnection['protocol'],
    apiKey: string | null = 'k',
  ) => ({
    protocol,
    baseUrl: 'https://example.test/v1/',
    apiKey,
  });

  it('四种协议各用对应的类；Base URL 去掉末尾斜杠；兼容协议的思考参数进 modelKwargs', () => {
    // 标准 OpenAI 走 Responses API（新推理模型在 Chat Completions 上不能同时带工具与推理）
    const oai = buildChatModel(
      conn('openai'),
      'gpt-5.6-luna',
      caps({
        thinkingStyle: 'openai-effort',
        thinkingLevels: ['auto', 'low', 'medium', 'high'],
      }),
      'high',
    );
    expect(oai).toBeInstanceOf(ChatOpenAI);
    expect(oai instanceof ChatOpenAI && oai.useResponsesApi).toBe(true);
    expect(oai instanceof ChatOpenAI && oai.reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    });
    // OpenAI 兼容（第三方）仍是 Chat Completions
    const compat = buildChatModel(conn('openai-compatible'), 'qwen3', caps());
    expect(compat instanceof ChatOpenAI && compat.useResponsesApi).toBe(false);
    const ds = buildChatModel(
      conn('openai-compatible'),
      'deepseek-flash',
      caps({
        thinkingStyle: 'thinking-type',
        thinkingLevels: ['auto', 'off', 'on'],
      }),
      'off',
    );
    expect(ds).toBeInstanceOf(ChatDeepSeek);
    expect(ds instanceof ChatDeepSeek && ds.modelKwargs).toEqual({
      thinking: { type: 'disabled' },
    });
    const claude = buildChatModel(
      conn('anthropic'),
      'claude-sonnet-4-5',
      caps({
        thinkingStyle: 'anthropic',
        thinkingLevels: ['auto', 'low', 'medium', 'high'],
      }),
      'low',
    );
    expect(claude).toBeInstanceOf(ChatAnthropic);
    expect(claude instanceof ChatAnthropic && claude.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
    expect(claude instanceof ChatAnthropic && claude.apiUrl).toBe(
      'https://example.test/v1',
    );
    expect(
      buildChatModel(conn('gemini'), 'gemini-3.8-flash', caps()),
    ).toBeInstanceOf(ChatGoogleGenerativeAI);
    expect(normalizeBaseUrl(' https://a.b/v1/// ')).toBe('https://a.b/v1');
  });

  it('本地服务没有 Key 也能构造（OpenAI 系客户端要求非空，填占位）', () => {
    expect(() =>
      buildChatModel(conn('openai-compatible', null), 'llama3:8b', caps()),
    ).not.toThrow();
  });

  it('只有 Gemini 能原样收下 provider 原生块', () => {
    expect(keepsNativeBlocksFor({ protocol: 'gemini' })).toBe(true);
    expect(keepsNativeBlocksFor({ protocol: 'anthropic' })).toBe(false);
  });
});

describe('listModels', () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  afterEach(() => fetchMock.mockReset());
  afterAll(() => fetchMock.mockRestore());

  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const calls = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url: url instanceof Request ? url.url : url.toString(),
      headers: init?.headers,
    }));

  it('OpenAI 系：GET {base}/models 带 Bearer；没 Key 不带；OpenRouter 的 context_length 带上；按 id 排序去重', async () => {
    fetchMock.mockImplementation(() =>
      json({
        data: [{ id: 'b' }, { id: 'a', context_length: 128000 }, { id: 'b' }],
      }),
    );
    const out = await listModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://x/v1/',
      apiKey: 'sk',
    });
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out[0].contextWindow).toBe(128000);
    expect(calls()[0]).toEqual({
      url: 'https://x/v1/models',
      headers: { Authorization: 'Bearer sk' },
    });
    await listModels({
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: null,
    });
    expect(calls()[1].headers).toEqual({});
  });

  it('Anthropic：x-api-key + anthropic-version，按 after_id 翻页', async () => {
    fetchMock
      .mockImplementationOnce(() =>
        json({
          data: [{ id: 'claude-a', display_name: 'A' }],
          has_more: true,
          last_id: 'claude-a',
        }),
      )
      .mockImplementationOnce(() =>
        json({ data: [{ id: 'claude-b' }], has_more: false }),
      );
    const out = await listModels({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'ak',
    });
    expect(out.map((m) => m.id)).toEqual(['claude-a', 'claude-b']);
    expect(calls()[0].url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000',
    );
    expect(calls()[1].url).toBe(
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a',
    );
    expect(calls()[0].headers).toEqual({
      'x-api-key': 'ak',
      'anthropic-version': '2023-06-01',
    });
  });

  it('Gemini：只留能 generateContent 的，去掉 models/ 前缀，带上下文窗口与是否支持思考', async () => {
    fetchMock.mockImplementation(() =>
      json({
        models: [
          {
            name: 'models/gemini-x',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1048576,
            thinking: true,
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    );
    const out = await listModels({
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'g',
    });
    expect(out).toEqual([
      {
        id: 'gemini-x',
        displayName: null,
        contextWindow: 1048576,
        thinking: true,
      },
    ]);
    expect(calls()[0].headers).toEqual({ 'x-goog-api-key': 'g' });
  });

  it('HTTP 失败带状态码与服务端原文；测连接把它变成失败结果而不是抛错', async () => {
    fetchMock.mockImplementation(() =>
      json({ error: { message: 'Invalid API key' } }, 401),
    );
    await expect(
      listModels({
        protocol: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'bad',
      }),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    const r = await testConnection({
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'bad',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('401');
    expect(r.message).toContain('Invalid API key');
  });
});

describe('OpenAI 思考摘要', () => {
  const conn = {
    protocol: 'openai' as const,
    baseUrl: 'https://x/v1',
    apiKey: 'k',
  };
  const effortCaps = (extra: Partial<ModelCapabilities> = {}) =>
    caps({
      thinkingStyle: 'openai-effort',
      thinkingLevels: ['auto', 'low', 'medium', 'high'],
      ...extra,
    });
  const reasoningOf = (m: unknown) =>
    m instanceof ChatOpenAI ? m.reasoning : 'not-openai';

  it('推理模型默认要摘要（auto 档也要）；关掉后只剩 effort；非推理模型不带 reasoning', () => {
    expect(
      reasoningOf(buildChatModel(conn, 'gpt-5.6', effortCaps(), 'auto')),
    ).toEqual({ summary: 'auto' });
    expect(
      reasoningOf(
        buildChatModel(
          conn,
          'gpt-5.6',
          effortCaps({ reasoningSummary: false }),
          'low',
        ),
      ),
    ).toEqual({ effort: 'low' });
    expect(
      reasoningOf(buildChatModel(conn, 'gpt-4o', caps(), 'high')),
    ).toBeUndefined();
  });

  it('测模型：带摘要报「组织未验证」→ 去掉摘要重测，通过则标记 reasoningSummaryUnsupported', async () => {
    const seen: unknown[] = [];
    jest.spyOn(ChatOpenAI.prototype, 'invoke').mockImplementation(function (
      this: ChatOpenAI,
    ) {
      seen.push(this.reasoning);
      return this.reasoning?.summary
        ? Promise.reject(
            new Error(
              '400 Your organization must be verified to generate reasoning summaries.',
            ),
          )
        : Promise.resolve(
            new AIMessageChunk({
              content: '',
              tool_calls: [{ id: '1', name: 'ping', args: { value: 'ok' } }],
            }),
          );
    });
    const r = await testModel(conn, 'gpt-5.6', effortCaps());
    expect(r).toMatchObject({
      status: 'ok',
      reasoningSummaryUnsupported: true,
    });
    expect(seen).toEqual([{ summary: 'auto' }, undefined]);
    jest.restoreAllMocks();
  });

  it('别的错误不重测；已关掉摘要的也不重测', async () => {
    const spy = jest
      .spyOn(ChatOpenAI.prototype, 'invoke')
      .mockImplementation(() =>
        Promise.reject(new Error('404 model not found')),
      );
    expect(await testModel(conn, 'gpt-5.6', effortCaps())).toMatchObject({
      status: 'error',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    spy.mockImplementation(() =>
      Promise.reject(new Error('400 reasoning summaries need verification')),
    );
    const r = await testModel(
      conn,
      'gpt-5.6',
      effortCaps({ reasoningSummary: false }),
    );
    expect(r.status).toBe('error');
    expect(r).not.toHaveProperty('reasoningSummaryUnsupported');
    expect(spy).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});

describe('testModel', () => {
  const conn: ProviderConnection = {
    protocol: 'openai',
    baseUrl: 'https://x/v1',
    apiKey: 'k',
  };

  function stubInvoke(result: AIMessageChunk | Error) {
    return jest
      .spyOn(ChatOpenAI.prototype, 'invoke')
      .mockImplementation(() =>
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result),
      );
  }
  afterEach(() => jest.restoreAllMocks());

  it('发起了工具调用 = ok；只回文字 = no_tools；报错 = error 带原文', async () => {
    stubInvoke(
      new AIMessageChunk({
        content: '',
        tool_calls: [{ id: '1', name: 'ping', args: { value: 'ok' } }],
      }),
    );
    expect((await testModel(conn, 'gpt-4o', caps())).status).toBe('ok');
    jest.restoreAllMocks();
    stubInvoke(new AIMessageChunk('ok'));
    expect((await testModel(conn, 'gpt-4o', caps())).status).toBe('no_tools');
    jest.restoreAllMocks();
    stubInvoke(new Error('404 model not found'));
    const r = await testModel(conn, 'gpt-x', caps());
    expect(r.status).toBe('error');
    expect(r.message).toContain('404 model not found');
  });
});

describe('model ref', () => {
  it('按第一个 / 切开：模型 id 可以带 / 与 :；不合法返回 null', () => {
    expect(modelRef('c1', 'anthropic/claude-sonnet-4')).toBe(
      'c1/anthropic/claude-sonnet-4',
    );
    expect(parseModelRef('c1/anthropic/claude-sonnet-4')).toEqual({
      connectionId: 'c1',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(parseModelRef('c1/llama3:8b')).toEqual({
      connectionId: 'c1',
      modelId: 'llama3:8b',
    });
    expect(parseModelRef('google-genai:gemini-3.8-flash')).toBeNull();
    expect(parseModelRef('c1/')).toBeNull();
    expect(parseModelRef(null)).toBeNull();
  });
});
