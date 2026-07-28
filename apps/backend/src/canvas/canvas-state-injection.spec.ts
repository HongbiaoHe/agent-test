import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { injectLiveCanvasState } from './canvas-state-injection';

const req = (messages: BaseMessage[] = [], sessionId?: string) => ({
  messages,
  runtime: { context: sessionId ? { sessionId } : {} },
  // 若实现改回 concat 进系统提示，下面的断言会立刻抓到
  systemMessage: {
    concat: jest.fn(() => ({ concated: true })),
  },
});

describe('injectLiveCanvasState', () => {
  it('把画布状态作为新消息追加到 messages 末尾，且不碰 systemMessage（保 prompt cache 前缀稳定）', async () => {
    const handler = jest.fn((r: unknown) => r);
    const request = req([new HumanMessage('原有对话')], 's1');

    await injectLiveCanvasState(request, handler, async () => '画布状态v1');

    const passed = handler.mock.calls[0][0] as { messages: BaseMessage[] };
    expect(passed.messages).toHaveLength(2);
    expect(passed.messages[0]).toBe(request.messages[0]); // 原有消息按引用透传，逐字不变
    expect(passed.messages[1].content).toBe('画布状态v1');
    // 关键回归点：绝不能拼进系统提示——那会让每次模型调用的前缀都不同，缓存命中率归零
    expect(request.systemMessage.concat).not.toHaveBeenCalled();
  });

  it('连续多次注入是 append-only：早先的消息保持不变，只在末尾增长', async () => {
    const handler = jest.fn((r: unknown) => r);
    let messages: BaseMessage[] = [new HumanMessage('原有对话')];

    for (const v of ['v1', 'v2', 'v3']) {
      handler.mockClear();
      await injectLiveCanvasState(req(messages, 's1'), handler, async () => v);
      messages = (handler.mock.calls[0][0] as { messages: BaseMessage[] })
        .messages;
    }

    // 前缀只增不改 —— 这正是缓存能逐次命中的前提
    expect(messages.map((m) => m.content)).toEqual([
      '原有对话',
      'v1',
      'v2',
      'v3',
    ]);
  });

  it('无 sessionId / 无取数函数 / 状态为空时原样透传，不追加消息', async () => {
    const handler = jest.fn((r: unknown) => r);

    await injectLiveCanvasState(req([], undefined), handler, async () => 'x');
    await injectLiveCanvasState(req([], 's1'), handler, undefined);
    await injectLiveCanvasState(req([], 's1'), handler, async () => '');

    expect(handler).toHaveBeenCalledTimes(3);
    for (const call of handler.mock.calls) {
      expect((call[0] as { messages: BaseMessage[] }).messages).toHaveLength(0);
    }
  });
});
