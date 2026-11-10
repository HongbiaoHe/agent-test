import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { priorMessageIds, readInterrupt } from './agent-state';

describe('priorMessageIds', () => {
  it('取 checkpoint 里全部带 id 的消息', async () => {
    const agent = {
      getState: () =>
        Promise.resolve({
          values: {
            messages: [
              new HumanMessage({ id: 'h1', content: 'q' }),
              new AIMessage({ id: 'a1', content: 'x' }),
              new AIMessage({ content: '无 id' }),
              { id: 'plain-object-不是消息' },
            ],
          },
        }),
    };
    expect(await priorMessageIds(agent, {})).toEqual(new Set(['h1', 'a1']));
  });

  it('首轮没有 state / 形状不对 → 空集', async () => {
    expect(
      await priorMessageIds({ getState: () => Promise.resolve({}) }, {}),
    ).toEqual(new Set());
    expect(
      await priorMessageIds({ getState: () => Promise.resolve('x') }, {}),
    ).toEqual(new Set());
  });

  it('读 checkpoint 抛错 → 空集并回调 onError，不往外抛', async () => {
    const onError = jest.fn();
    const ids = await priorMessageIds(
      { getState: () => Promise.reject(new Error('db down')) },
      {},
      onError,
    );
    expect(ids).toEqual(new Set());
    expect(onError).toHaveBeenCalledWith(new Error('db down'));
  });
});

describe('readInterrupt', () => {
  it('取第一个挂起的中断及被拦的工具名', () => {
    const value = { actionRequests: [{ name: 'ask_user', args: {} }] };
    expect(
      readInterrupt({
        tasks: [{ interrupts: [] }, { interrupts: [{ value }, { value: 2 }] }],
      }),
    ).toEqual({ value, toolName: 'ask_user' });
  });

  it('载荷不是审批请求的形状 → 仍返回中断，toolName 为空', () => {
    expect(
      readInterrupt({ tasks: [{ interrupts: [{ value: 'x' }] }] }),
    ).toEqual({ value: 'x', toolName: undefined });
  });

  it('没有中断 / 没有 tasks / 形状不对 → null', () => {
    expect(readInterrupt({ tasks: [] })).toBeNull();
    expect(readInterrupt({ tasks: [{}] })).toBeNull();
    expect(readInterrupt({})).toBeNull();
    expect(readInterrupt(null)).toBeNull();
  });
});
