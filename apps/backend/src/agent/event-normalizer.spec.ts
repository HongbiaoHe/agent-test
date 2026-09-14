import {
  AIMessageChunk,
  ToolMessage,
  type MessageContent,
  type ToolCall,
} from '@langchain/core/messages';
import { extractThinkingBlocks, normalize } from './event-normalizer';

const aiMsg = (content: MessageContent, toolCalls: ToolCall[] = []) =>
  new AIMessageChunk({ content, tool_calls: toolCalls });
/** 推理型模型的思考增量：deepseek 系落在 additional_kwargs.reasoning_content。 */
const reasoningMsg = (reasoning: string, content: MessageContent = '') =>
  new AIMessageChunk({
    content,
    additional_kwargs: { reasoning_content: reasoning },
  });
const toolMsg = (name: string, content: string) =>
  new ToolMessage({ name, content, tool_call_id: 'tc-1', status: 'success' });

describe('normalize', () => {
  it('messages + ToolMessage → tool_end', () => {
    const ev = normalize(['tools:x'], 'messages', [
      toolMsg('get_weather', '{}'),
    ]);
    expect(ev).toEqual({
      type: 'tool_end',
      payload: { name: 'get_weather', content: '{}', status: 'success' },
    });
  });

  it('messages + AIMessageChunk(文本) → token', () => {
    const ev = normalize(['model_request:x'], 'messages', [aiMsg('你好')]);
    expect(ev).toEqual({ type: 'token', payload: { text: '你好' } });
  });

  it('messages + AIMessageChunk(思考增量) → reasoning', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      reasoningMsg('先比较小数位…'),
    ]);
    expect(ev).toEqual({
      type: 'reasoning',
      payload: { text: '先比较小数位…', sourceId: '' },
    });
  });

  it('思考优先于正文：同一 chunk 两者都有时不吞掉思考', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      reasoningMsg('思考', '正文'),
    ]);
    expect(ev).toEqual({
      type: 'reasoning',
      payload: { text: '思考', sourceId: '' },
    });
  });

  it('Gemini 的 thinking 块 → reasoning（不能用 msg.text 取，那会丢掉思考）', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      new AIMessageChunk({
        content: [{ type: 'thinking', thinking: '**先看清题目**\n分母是 12…' }],
      }),
    ]);
    expect(ev).toEqual({
      type: 'reasoning',
      payload: { text: '**先看清题目**\n分母是 12…', sourceId: '' },
    });
  });

  it('Gemini 同一 chunk 多个 thinking 块 → 按序拼接', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      new AIMessageChunk({
        content: [
          { type: 'thinking', thinking: '前半' },
          { type: 'thinking', thinking: '后半' },
        ],
      }),
    ]);
    expect(ev).toEqual({
      type: 'reasoning',
      payload: { text: '前半后半', sourceId: '' },
    });
  });

  it('Gemini 的 text 块仍走 token，不被误判成思考', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      new AIMessageChunk({ content: [{ type: 'text', text: '答案是 28' }] }),
    ]);
    expect(ev).toEqual({ type: 'token', payload: { text: '答案是 28' } });
  });

  it('非推理模型（无 reasoning_content）照常出 token', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      new AIMessageChunk({ content: '你好', additional_kwargs: {} }),
    ]);
    expect(ev).toEqual({ type: 'token', payload: { text: '你好' } });
  });

  it('messages + AIMessageChunk(空内容) → null', () => {
    expect(normalize(['model_request:x'], 'messages', [aiMsg('')])).toBeNull();
  });

  it('messages + functionCall 数组内容(无 text) → null', () => {
    const ev = normalize(['model_request:x'], 'messages', [
      aiMsg([{ type: 'functionCall', functionCall: { name: 'get_weather' } }]),
    ]);
    expect(ev).toBeNull();
  });

  it('updates + todos → plan_update', () => {
    const ev = normalize([], 'updates', {
      'todoListMiddleware.after_model': {
        todos: [{ content: '查天气', status: 'pending' }],
      },
    });
    expect(ev).toEqual({
      type: 'plan_update',
      payload: { todos: [{ content: '查天气', status: 'pending' }] },
    });
  });

  it('updates + AIMessage(tool_calls) → tool_start', () => {
    const ev = normalize([], 'updates', {
      model_request: {
        messages: [
          aiMsg('', [
            {
              name: 'get_weather',
              args: { city: '上海' },
              id: 'call-1',
              type: 'tool_call',
            },
          ]),
        ],
      },
    });
    expect(ev).toEqual({
      type: 'tool_start',
      payload: {
        tool_calls: [{ name: 'get_weather', args: { city: '上海' } }],
      },
    });
  });

  it('updates + AIMessage(文本) → message', () => {
    const ev = normalize([], 'updates', {
      model_request: { messages: [aiMsg('最终回答')] },
    });
    expect(ev).toEqual({ type: 'message', payload: { text: '最终回答' } });
  });

  it('空中间件钩子 → null', () => {
    expect(
      normalize([], 'updates', { 'FilesystemMiddleware.before_agent': {} }),
    ).toBeNull();
  });
});

/**
 * Gemini 的思考只能从 updates 拿：messages 流会把 content 压成 string 丢掉 thinking 块
 * （实测一整轮 canvas run 全是 contentType:"string"）。
 */
describe('extractThinkingBlocks', () => {
  const aiWithThinking = (id: string, thinking: string) =>
    new AIMessageChunk({ id, content: [{ type: 'thinking', thinking }] });
  const update = (...msgs: AIMessageChunk[]) => ({
    model_request: { messages: msgs },
  });

  it('抽取 updates 里的 thinking 正文，并带上归属的源消息 id', () => {
    const out = extractThinkingBlocks(
      update(aiWithThinking('m1', '先看安全区再放节点')),
    );
    expect(out).toEqual([{ id: 'm1', text: '先看安全区再放节点' }]);
  });

  it('照实返回、**不在这里去重**——哪些该丢由调用方按上下文判定（见 ReasoningCollector）', () => {
    const data = update(aiWithThinking('m1', '思考'));
    expect(extractThinkingBlocks(data)).toHaveLength(1);
    expect(extractThinkingBlocks(data)).toHaveLength(1);
  });

  it('消息没有 id 时 id 为空串（调用方退化成按正文归一）', () => {
    const noId = new AIMessageChunk({
      content: [{ type: 'thinking', thinking: '无 id 的思考' }],
    });
    expect(extractThinkingBlocks(update(noId))).toEqual([
      { id: '', text: '无 id 的思考' },
    ]);
  });

  it('不碰 DeepSeek 的 reasoning_content——那条已由 messages 流推送，重复取会落两份', () => {
    const ds = new AIMessageChunk({
      id: 'd1',
      content: '',
      additional_kwargs: { reasoning_content: 'deepseek 的思考' },
    });
    expect(extractThinkingBlocks(update(ds))).toEqual([]);
  });

  it('纯文本消息 / 空更新 → 空数组', () => {
    const plain = new AIMessageChunk({ id: 't1', content: '答案' });
    expect(extractThinkingBlocks(update(plain))).toEqual([]);
    expect(extractThinkingBlocks(null)).toEqual([]);
    expect(extractThinkingBlocks({ tools: {} })).toEqual([]);
  });
});
