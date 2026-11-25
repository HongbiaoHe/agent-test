import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, fakeModel } from 'langchain';
import { z } from 'zod';
import { normalize } from '../agent/event-normalizer';
import {
  createSteeringMiddleware,
  isSteeringMessage,
  type SteeringMessage,
  steeringText,
} from './steering';

const echo = tool(({ text }: { text: string }) => `echo:${text}`, {
  name: 'echo',
  description: 'echo',
  schema: z.object({ text: z.string() }),
});

/** 记下每次模型调用收到的消息（类型:正文） */
function recordingModel(calls: string[][]) {
  const record = (messages: BaseMessage[]) => {
    calls.push(messages.map((m) => `${m.getType()}:${m.text}`));
  };
  return fakeModel()
    .respond((messages) => {
      record(messages);
      return new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'echo', args: { text: 'a' }, type: 'tool_call' },
        ],
      });
    })
    .respond((messages) => {
      record(messages);
      return new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c2', name: 'echo', args: { text: 'b' }, type: 'tool_call' },
        ],
      });
    })
    .respond((messages) => {
      record(messages);
      return new AIMessage('done');
    });
}

describe('steering 中间件', () => {
  it('待插入的消息在下一次模型调用前写进对话：排在工具结果之后，多条一起，之后每次调用前缀不变', async () => {
    const calls: string[][] = [];
    // 第 1 次模型调用时队列是空的；工具跑完后、第 2 次调用前有两条
    const queue: SteeringMessage[][] = [
      [],
      [
        { id: 's1', text: steeringText('改成用中文') },
        { id: 's2', text: steeringText('再加一个标题') },
      ],
      [],
    ];
    let takes = 0;
    const agent = createAgent({
      model: recordingModel(calls),
      tools: [echo],
      middleware: [createSteeringMiddleware(() => queue[takes++] ?? [])],
    });

    const out = await agent.invoke({ messages: [new HumanMessage('go')] });

    expect(takes).toBe(3);
    expect(calls[0]).toEqual(['human:go']);
    expect(calls[1]).toEqual([
      'human:go',
      'ai:',
      'tool:echo:a',
      `human:${steeringText('改成用中文')}`,
      `human:${steeringText('再加一个标题')}`,
    ]);
    // 第 3 次调用：前面的部分与第 2 次完全一样（插入的消息留在原位），只在后面追加
    expect(calls[2].slice(0, calls[1].length)).toEqual(calls[1]);
    expect(calls[2].slice(calls[1].length)).toEqual(['ai:', 'tool:echo:b']);
    // 写进了 state：带 id 与标记
    const injected = out.messages.filter((m) => isSteeringMessage(m));
    expect(injected.map((m) => m.id)).toEqual(['s1', 's2']);
  });

  it('没有待插入的消息时不动对话', async () => {
    const calls: string[][] = [];
    const agent = createAgent({
      model: recordingModel(calls),
      tools: [echo],
      middleware: [createSteeringMiddleware(() => [])],
    });
    const out = await agent.invoke({ messages: [new HumanMessage('go')] });
    expect(out.messages.filter((m) => isSteeringMessage(m))).toEqual([]);
    expect(calls[2]).toEqual([
      'human:go',
      'ai:',
      'tool:echo:a',
      'ai:',
      'tool:echo:b',
    ]);
  });

  it('updates 流里按顺序出现：工具结果 → 插入的用户消息 → 下一次模型输出', async () => {
    const agent = createAgent({
      model: recordingModel([]),
      tools: [echo],
      middleware: [
        createSteeringMiddleware(
          (() => {
            let n = 0;
            return () =>
              n++ === 1 ? [{ id: 's1', text: steeringText('x') }] : [];
          })(),
        ),
      ],
    });
    const types: string[] = [];
    for await (const chunk of await agent.stream(
      { messages: [new HumanMessage('go')] },
      { streamMode: ['updates'] },
    )) {
      const [mode, data] = chunk;
      const ev = normalize([], mode, data);
      if (!ev) continue;
      types.push(
        ev.type === 'user_message'
          ? `user_message:${JSON.stringify(ev.payload)}`
          : ev.type,
      );
    }
    expect(types).toEqual([
      'tool_start',
      'tool_end',
      'user_message:{"ids":["s1"]}',
      'tool_start',
      'tool_end',
      'message',
    ]);
  });

  it('normalize：普通的 HumanMessage 更新不当成插入消息', () => {
    expect(
      normalize([], 'updates', { n: { messages: [new HumanMessage('hi')] } }),
    ).toBeNull();
    expect(
      normalize([], 'updates', {
        n: {
          messages: [
            new ToolMessage({ content: 'r', tool_call_id: 'c', name: 't' }),
          ],
        },
      })?.type,
    ).toBe('tool_end');
  });
});
