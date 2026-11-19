import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  MAX_INVALID_TOOL_CALL_RETRIES,
  recoverInvalidToolCalls,
  repairJsonArgs,
} from './invalid-tool-calls';

describe('repairJsonArgs', () => {
  it('合法 JSON 原样；尾逗号、缺右括号 / 引号、代码块包裹都能修', () => {
    expect(repairJsonArgs('{"a":1}')).toEqual({ a: 1 });
    expect(repairJsonArgs('{"a":1,}')).toEqual({ a: 1 });
    expect(repairJsonArgs('{"a":{"b":[1,2')).toEqual({ a: { b: [1, 2] } });
    expect(repairJsonArgs('{"x": "hi')).toEqual({ x: 'hi' });
    expect(repairJsonArgs('```json\n{"a": "b",}\n```')).toEqual({ a: 'b' });
    expect(repairJsonArgs('  ')).toEqual({});
  });

  it('修不了或不是对象 → null', () => {
    expect(repairJsonArgs('a=1, b=2')).toBeNull();
    expect(repairJsonArgs('[1,2]')).toBeNull();
    expect(repairJsonArgs('{"a" 1}')).toBeNull();
  });
});

const invalid = (args: string, extra: Partial<AIMessage> = {}) =>
  new AIMessage({
    id: 'm1',
    content: '',
    invalid_tool_calls: [
      {
        id: 'bad1',
        name: 'echo',
        args,
        error: 'Malformed args',
        type: 'invalid_tool_call',
      },
    ],
    usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    ...extra,
  });

describe('recoverInvalidToolCalls', () => {
  const request = { messages: [new HumanMessage('go')] as BaseMessage[] };

  it('没有坏调用：原样返回，只调用一次模型', async () => {
    const ok = new AIMessage('答案');
    const handler = jest.fn().mockResolvedValue(ok);
    expect(await recoverInvalidToolCalls(request, handler)).toBe(ok);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('能修的并进 tool_calls（保留 id / usage），不重调模型', async () => {
    const handler = jest.fn().mockResolvedValue(invalid('{"x": "hi"'));
    const res = await recoverInvalidToolCalls(request, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.tool_calls).toEqual([
      { id: 'bad1', name: 'echo', args: { x: 'hi' }, type: 'tool_call' },
    ]);
    expect(res.invalid_tool_calls).toEqual([]);
    expect(res.id).toBe('m1');
    expect(res.usage_metadata?.total_tokens).toBe(5);
  });

  it('修不了：补上「坏调用 + 错误结果」重调模型（原请求不被改动），模型改对后返回新的响应', async () => {
    const fixed = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'c2', name: 'echo', args: { x: 'ok' }, type: 'tool_call' },
      ],
    });
    const handler = jest
      .fn<Promise<AIMessage>, [{ messages: BaseMessage[] }]>()
      .mockResolvedValueOnce(invalid('x=1 y=2'))
      .mockResolvedValueOnce(fixed);
    const res = await recoverInvalidToolCalls(request, handler);
    expect(res).toBe(fixed);
    expect(request.messages).toHaveLength(1);
    const retried = handler.mock.calls[1][0].messages;
    expect(retried).toHaveLength(3);
    const ai = retried[1];
    expect(AIMessage.isInstance(ai) && ai.tool_calls?.[0]).toMatchObject({
      id: 'bad1',
      name: 'echo',
      args: {},
    });
    const tool = retried[2];
    expect(ToolMessage.isInstance(tool) && tool.tool_call_id).toBe('bad1');
    expect(tool.text).toContain('invalid_tool_call_arguments');
    expect(tool.text).toContain('x=1 y=2');
  });

  it('重试用完仍不合法：不再静默结束，正文给出说明且没有可执行调用', async () => {
    const handler = jest.fn().mockResolvedValue(invalid('nope'));
    const res = await recoverInvalidToolCalls(request, handler);
    expect(handler).toHaveBeenCalledTimes(MAX_INVALID_TOOL_CALL_RETRIES + 1);
    expect(res.tool_calls).toEqual([]);
    expect(res.text).toContain('工具调用的参数格式多次不合法');
    expect(res.text).toContain('echo');
  });
});
