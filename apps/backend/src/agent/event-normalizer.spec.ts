import {
  AIMessageChunk,
  ToolMessage,
  type MessageContent,
  type ToolCall,
} from '@langchain/core/messages';
import { normalize } from './event-normalizer';

const aiMsg = (content: MessageContent, toolCalls: ToolCall[] = []) =>
  new AIMessageChunk({ content, tool_calls: toolCalls });
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
