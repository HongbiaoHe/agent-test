import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import type { RawEvent } from '../agent/event-normalizer';
import type { CallUsage } from '../agent/token-usage';
import {
  type ConsumeStreamOptions,
  consumeAgentStream,
  type TurnSink,
} from './consume-stream';

/** 记录 sink 收到的全部调用（按发生顺序） */
function recordingSink(
  recordUsage: (call: CallUsage) => number | null = () => null,
) {
  const log: { op: 'emit' | 'persist'; event: RawEvent }[] = [];
  const usages: CallUsage[] = [];
  const sink: TurnSink = {
    emit: (event) => {
      log.push({ op: 'emit', event });
    },
    // 异步落库：顺序也必须保持
    persist: async (event) => {
      await Promise.resolve();
      log.push({ op: 'persist', event });
    },
    recordUsage: (call) => {
      usages.push(call);
      return recordUsage(call);
    },
  };
  const persisted = () =>
    log.filter((l) => l.op === 'persist').map((l) => l.event);
  const emitted = () => log.filter((l) => l.op === 'emit').map((l) => l.event);
  return { sink, log, usages, persisted, emitted };
}

/** tool_start 载荷里的调用 id（没有 id 为 undefined） */
function toolStartIds(payload: unknown): (string | undefined)[] {
  return z
    .object({ tool_calls: z.array(z.object({ id: z.string().optional() })) })
    .parse(payload)
    .tool_calls.map((c) => c.id);
}

async function* streamOf(chunks: unknown[]) {
  for (const c of chunks) yield c;
}

const opts = (extra: Partial<ConsumeStreamOptions> = {}) => ({
  priorIds: new Set<string>(),
  seenUsageIds: new Set<string>(),
  fallbackModel: 'gemini-x',
  ...extra,
});

const token = (content: string) => [
  ['agent'],
  'messages',
  [new AIMessageChunk({ content })],
];
const updateWith = (node: string, ...messages: unknown[]) => [
  [],
  'updates',
  { [node]: { messages } },
];
const toolCallMsg = (name: string) =>
  new AIMessageChunk({
    content: '',
    tool_calls: [{ name, args: { q: 'x' }, id: 'call-0', type: 'tool_call' }],
  });
const toolResult = (name: string, content: string) => [
  ['tools'],
  'messages',
  [
    new ToolMessage({
      name,
      content,
      tool_call_id: 'call-0',
      status: 'success',
    }),
  ],
];

describe('consumeAgentStream — 文本段收口', () => {
  it('逐字 token 只推流；工具调用前把叙述收口成一条 message，最终答案同理；顺序与用户看到的一致', async () => {
    const { sink, persisted, emitted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        token('你好'),
        token('，世界'),
        updateWith('model_request', toolCallMsg('search')),
        toolResult('search', '{"r":1}'),
        token('最终答案'),
        updateWith(
          'model_request',
          new AIMessageChunk({ content: '最终答案' }),
        ),
      ]),
      sink,
      opts(),
    );
    expect(persisted().map((e) => e.type)).toEqual([
      'message',
      'tool_start',
      'tool_end',
      'message',
    ]);
    expect(persisted()[0].payload).toEqual({ text: '你好，世界' });
    expect(persisted()[3].payload).toEqual({ text: '最终答案' });
    // token 推了流、没落库；收口的 message 与边界事件既推流又落库
    expect(emitted().filter((e) => e.type === 'token')).toHaveLength(3);
    expect(emitted().map((e) => e.type)).toEqual([
      'token',
      'token',
      'message',
      'tool_start',
      'tool_end',
      'token',
      'message',
    ]);
  });

  it('updates 的 message 文本比逐字流短时，以逐字累积的为准', async () => {
    const { sink, persisted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        token('完整的'),
        token('回答'),
        updateWith('model_request', new AIMessageChunk({ content: '回答' })),
      ]),
      sink,
      opts(),
    );
    expect(persisted()).toEqual([
      { type: 'message', payload: { text: '完整的回答' } },
    ]);
  });

  it('非流式模型（没有逐字 token）退回 updates 的 message 文本', async () => {
    const { sink, persisted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        updateWith('model_request', new AIMessage({ content: '整段' })),
      ]),
      sink,
      opts(),
    );
    expect(persisted()).toEqual([
      { type: 'message', payload: { text: '整段' } },
    ]);
  });

  it('流自然结束时收口末段文本；计划更新也是文本段边界', async () => {
    const { sink, persisted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        token('先拆一下'),
        [
          [],
          'updates',
          { todo: { todos: [{ content: 'a', status: 'pending' }] } },
        ],
        token('开始干'),
      ]),
      sink,
      opts(),
    );
    expect(persisted().map((e) => [e.type, e.payload])).toEqual([
      ['message', { text: '先拆一下' }],
      ['plan_update', { todos: [{ content: 'a', status: 'pending' }] }],
      ['message', { text: '开始干' }],
    ]);
  });

  it('同一条正文（同一消息 id）跨节点回显只收口一次；不同消息的相同正文照常收口；没有 id 的不去重', async () => {
    const { sink, persisted } = recordingSink();
    const msg = (id: string | undefined, text: string) =>
      new AIMessage({ id, content: text });
    await consumeAgentStream(
      streamOf([
        token('好的'),
        updateWith('model_request', msg('m1', '好的')),
        updateWith('todoListMiddleware.after_model', msg('m1', '好的')),
        // 另一条消息、正文恰好相同、中间没有别的事件：不能被当成回显吞掉
        updateWith('model_request', msg('m2', '好的')),
        updateWith('model_request', msg(undefined, '无 id')),
        updateWith('todoListMiddleware.after_model', msg(undefined, '无 id')),
      ]),
      sink,
      opts(),
    );
    expect(persisted().map((e) => e.payload)).toEqual([
      { text: '好的' },
      { text: '好的' },
      { text: '无 id' },
      { text: '无 id' },
    ]);
  });

  it('同一工具调用（同一 tool_call id）跨节点回显只推一次；回显里夹带的新调用照常推', async () => {
    const { sink, persisted } = recordingSink();
    const calls = (...ids: (string | undefined)[]) =>
      new AIMessageChunk({
        content: '',
        tool_calls: ids.map((id) => ({
          name: 'add_layers',
          args: {},
          id,
          type: 'tool_call' as const,
        })),
      });
    await consumeAgentStream(
      streamOf([
        updateWith('model_request', calls('c1')),
        updateWith('tools', calls('c1')),
        updateWith('model_request', calls('c1', 'c2')),
        // 没有 id 的调用不去重（宁可重复也不误吞）
        updateWith('model_request', calls(undefined)),
        updateWith('tools', calls(undefined)),
      ]),
      sink,
      opts(),
    );
    const starts = persisted().filter((e) => e.type === 'tool_start');
    expect(
      starts.map((e) => toolStartIds(e.payload).map((id) => id ?? '(no id)')),
    ).toEqual([['c1'], ['c2'], ['(no id)'], ['(no id)']]);
  });

  it('不开 subgraphs 的 [mode, data] 二元组同样能消费（设计 agent）', async () => {
    const { sink, persisted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        ['messages', [new AIMessageChunk({ content: '你好' })]],
        ['updates', { model_request: { messages: [new AIMessage('你好')] } }],
      ]),
      sink,
      opts(),
    );
    expect(persisted()).toEqual([
      { type: 'message', payload: { text: '你好' } },
    ]);
  });

  it('mapEvent：宿主改写非文本事件；返回 null 整条丢弃且不触发文本段收口', async () => {
    const { sink, log } = recordingSink();
    await consumeAgentStream(
      streamOf([
        updateWith('model_request', toolCallMsg('render_preview')),
        token('半句'),
        // 被宿主丢掉的计划更新：不应把「半句」提前收口
        [
          [],
          'updates',
          { todo: { todos: [{ content: 'a', status: 'pending' }] } },
        ],
        toolResult('render_preview', 'png'),
      ]),
      sink,
      opts({
        mapEvent: (e) => {
          if (e.type === 'plan_update') return null;
          if (e.type === 'tool_end') {
            return { type: 'tool_end', payload: { content: '[预览图]' } };
          }
          return e;
        },
      }),
    );
    expect(log.map((l) => [l.op, l.event.type])).toEqual([
      ['emit', 'tool_start'],
      ['persist', 'tool_start'],
      ['emit', 'token'],
      ['emit', 'message'],
      ['persist', 'message'],
      ['emit', 'tool_end'],
      ['persist', 'tool_end'],
    ]);
    expect(log.at(-1)?.event.payload).toEqual({ content: '[预览图]' });
  });

  it('不认识的流元组形状直接报错（不静默吞掉）', async () => {
    const { sink } = recordingSink();
    await expect(
      consumeAgentStream(streamOf([{ not: 'a tuple' }]), sink, opts()),
    ).rejects.toThrow();
  });
});

describe('consumeAgentStream — 思考', () => {
  const thinkingChunk = (id: string, reasoning: string) => [
    ['agent'],
    'messages',
    [
      new AIMessageChunk({
        id,
        content: '',
        additional_kwargs: { reasoning_content: reasoning },
      }),
    ],
  ];
  const geminiMsg = (id: string, thinking: string, text: string) =>
    new AIMessageChunk({
      id,
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text },
      ],
    });

  it('DeepSeek 增量逐块推流；整段只落一行（重复的短增量不被吞），且落在正文之前', async () => {
    const { sink, persisted, emitted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        thinkingChunk('ai-1', '先'),
        thinkingChunk('ai-1', '想'),
        thinkingChunk('ai-1', '想'),
        token('答案'),
      ]),
      sink,
      opts(),
    );
    expect(emitted().filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', payload: { sourceId: 'ai-1', text: '先' } },
      { type: 'reasoning', payload: { sourceId: 'ai-1', text: '想' } },
      { type: 'reasoning', payload: { sourceId: 'ai-1', text: '想' } },
    ]);
    expect(persisted()).toEqual([
      { type: 'reasoning', payload: { sourceId: 'ai-1', text: '先想想' } },
      { type: 'message', payload: { text: '答案' } },
    ]);
  });

  it('Gemini 思考从 updates 整块取：跨节点回显只推一次、只落一行', async () => {
    const { sink, persisted, emitted } = recordingSink();
    const g = geminiMsg('g-1', '分析一下', '结论');
    await consumeAgentStream(
      streamOf([
        token('结论'),
        updateWith('model_request', g),
        updateWith('after_model', g),
      ]),
      sink,
      opts(),
    );
    expect(emitted().filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', payload: { sourceId: 'g-1', text: '分析一下' } },
    ]);
    expect(persisted().filter((e) => e.type === 'reasoning')).toEqual([
      { type: 'reasoning', payload: { sourceId: 'g-1', text: '分析一下' } },
    ]);
  });

  it('checkpoint 回放的旧消息（priorIds）的思考整条丢弃', async () => {
    const { sink, log } = recordingSink();
    await consumeAgentStream(
      streamOf([updateWith('model_request', geminiMsg('g-old', '旧思考', ''))]),
      sink,
      opts({ priorIds: new Set(['g-old']) }),
    );
    expect(log.some((l) => l.event.type === 'reasoning')).toBe(false);
  });
});

describe('consumeAgentStream — token 记账', () => {
  const withUsage = (id: string, input: number, output: number) =>
    new AIMessage({
      id,
      content: '',
      usage_metadata: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        input_token_details: { cache_read: 4 },
      },
    });

  it('每次模型调用记一次账并推 token_usage（会话累计）；同一 AIMessage 跨节点回显只记一次', async () => {
    let total = 100;
    const { sink, usages, emitted } = recordingSink(
      (call) => (total += call.total),
    );
    const m = withUsage('ai-1', 10, 5);
    await consumeAgentStream(
      streamOf([updateWith('model_request', m), updateWith('after_model', m)]),
      sink,
      opts(),
    );
    expect(usages).toHaveLength(1);
    expect(emitted().filter((e) => e.type === 'token_usage')).toEqual([
      {
        type: 'token_usage',
        payload: {
          model: 'gemini-x',
          input: 10,
          output: 5,
          total: 15,
          cacheRead: 4,
          cacheCreation: 0,
          cumulativeTotal: 115,
        },
      },
    ]);
  });

  it('已落库的（seenUsageIds 预热）不再记账；宿主判定重复（返回 null）就不推 token_usage', async () => {
    const { sink, usages, emitted } = recordingSink(() => null);
    await consumeAgentStream(
      streamOf([
        updateWith('model_request', withUsage('old', 1, 1)),
        updateWith('model_request', withUsage('new', 2, 2)),
      ]),
      sink,
      opts({ seenUsageIds: new Set(['old']) }),
    );
    expect(usages.map((u) => u.messageId)).toEqual(['new']);
    expect(emitted().some((e) => e.type === 'token_usage')).toBe(false);
  });
});

describe('consumeAgentStream — 停止与失败', () => {
  async function* failingAfter(chunks: unknown[], onFail: () => void) {
    for (const c of chunks) yield c;
    onFail();
    throw new Error('Aborted');
  }

  it('被停止：已推给前端的残余文本收口落库，再把错误抛给宿主', async () => {
    const { sink, persisted } = recordingSink();
    const ac = new AbortController();
    await expect(
      consumeAgentStream(
        failingAfter([token('写到一半')], () => ac.abort()),
        sink,
        opts({ signal: ac.signal }),
      ),
    ).rejects.toThrow('Aborted');
    expect(persisted()).toEqual([
      { type: 'message', payload: { text: '写到一半' } },
    ]);
  });

  it('其它错误：不收口残余文本，原样抛出', async () => {
    const { sink, persisted } = recordingSink();
    await expect(
      consumeAgentStream(
        failingAfter([token('写到一半')], () => undefined),
        sink,
        opts({ signal: new AbortController().signal }),
      ),
    ).rejects.toThrow('Aborted');
    expect(persisted()).toEqual([]);
  });
});

describe('consumeAgentStream — 子 agent', () => {
  const sub = (task: string, inner: string) => [`tools:${task}`, inner];
  const taskStart = (task: string, callId: string, type: string) => [
    [],
    'tasks',
    {
      id: task,
      name: 'tools',
      input: {
        lg_tool_call: {
          id: callId,
          name: 'task',
          args: { subagent_type: type },
        },
      },
    },
  ];
  const subToken = (task: string, content: string) => [
    sub(task, 'model_request:x'),
    'messages',
    [new AIMessageChunk({ content })],
  ];
  const subUpdate = (task: string, msg: unknown) => [
    [`tools:${task}`],
    'updates',
    { model_request: { messages: [msg] } },
  ];
  const taskResult = (callId: string, content: string) => [
    [],
    'updates',
    {
      tools: {
        messages: [
          new ToolMessage({ name: 'task', content, tool_call_id: callId }),
        ],
      },
    },
  ];

  it('并行子 agent 的正文各自累积、带 subagent 归属落库；task 结果（只在 updates 里）作为主 agent 的 tool_end', async () => {
    const { sink, persisted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        updateWith(
          'model_request',
          new AIMessageChunk({
            content: '',
            tool_calls: [
              { name: 'task', args: {}, id: 'cA', type: 'tool_call' },
              { name: 'task', args: {}, id: 'cB', type: 'tool_call' },
            ],
          }),
        ),
        taskStart('tA', 'cA', 'writer'),
        taskStart('tB', 'cB', 'critic'),
        subToken('tA', '甲1'),
        subToken('tB', '乙1'),
        subToken('tA', '甲2'),
        subUpdate('tA', new AIMessage({ id: 'ma', content: '甲1甲2' })),
        subUpdate('tB', new AIMessage({ id: 'mb', content: '乙1' })),
        taskResult('cA', '甲的结果'),
        taskResult('cB', '乙的结果'),
        token('汇总'),
      ]),
      sink,
      opts(),
    );
    expect(persisted()).toEqual([
      expect.objectContaining({ type: 'tool_start' }),
      {
        type: 'message',
        payload: { text: '甲1甲2', subagent: { callId: 'cA', name: 'writer' } },
      },
      {
        type: 'message',
        payload: { text: '乙1', subagent: { callId: 'cB', name: 'critic' } },
      },
      expect.objectContaining({
        type: 'tool_end',
        payload: expect.objectContaining({
          toolCallId: 'cA',
          content: '甲的结果',
        }),
      }),
      expect.objectContaining({
        type: 'tool_end',
        payload: expect.objectContaining({ toolCallId: 'cB' }),
      }),
      { type: 'message', payload: { text: '汇总' } },
    ]);
    const mainEnds = persisted().filter((e) => e.type === 'tool_end');
    expect(mainEnds.every((e) => !('subagent' in (e.payload as object)))).toBe(
      true,
    );
  });

  it('普通工具结果（namespace 只有 tools:<id> 一段）归主 agent；messages 与 updates 各出现一次只认第一次', async () => {
    const { sink, persisted } = recordingSink();
    const result = new ToolMessage({
      name: 'search',
      content: 'r',
      tool_call_id: 'call-0',
    });
    await consumeAgentStream(
      streamOf([
        updateWith('model_request', toolCallMsg('search')),
        [['tools:t9'], 'messages', [result]],
        [[], 'updates', { tools: { messages: [result] } }],
      ]),
      sink,
      opts(),
    );
    const ends = persisted().filter((e) => e.type === 'tool_end');
    expect(ends).toHaveLength(1);
    expect('subagent' in (ends[0].payload as object)).toBe(false);
  });

  it('子 agent 的 todo 计划不推不落；映射不到 task 时以 namespace 段作归属', async () => {
    const { sink, persisted, emitted } = recordingSink();
    await consumeAgentStream(
      streamOf([
        [
          ['tools:tZ'],
          'updates',
          {
            todoListMiddleware: {
              todos: [{ content: 'x', status: 'pending' }],
            },
          },
        ],
        subToken('tZ', '无映射'),
      ]),
      sink,
      opts(),
    );
    expect(emitted().some((e) => e.type === 'plan_update')).toBe(false);
    expect(persisted()).toEqual([
      {
        type: 'message',
        payload: { text: '无映射', subagent: { callId: 'tools:tZ', name: '' } },
      },
    ]);
  });
});

describe('运行中插入的用户消息（steering）', () => {
  const steered = (...ids: string[]) => [
    [],
    'updates',
    {
      'steeringMiddleware.before_model': {
        messages: ids.map(
          (id) =>
            new HumanMessage({
              id,
              content: `note\n\n${id}`,
              additional_kwargs: { steering: true },
            }),
        ),
      },
    },
  ];

  it('按流里的位置交给 sink.steered：前面的文本先收口，同一个 id 只认一次', async () => {
    const { sink, log } = recordingSink();
    const order: string[] = [];
    sink.steered = async (id) => {
      await Promise.resolve();
      order.push(
        `steered:${id}@${log.filter((l) => l.op === 'persist').length}`,
      );
    };
    await consumeAgentStream(
      streamOf([
        token('先说一句'),
        steered('s1', 's2'),
        // 审批续跑回放同一条 update：不重复交付
        steered('s1', 's2'),
        token('再说一句'),
      ]),
      sink,
      opts(),
    );
    // 交付时「先说一句」已经落库（1 行），「再说一句」还没有
    expect(order).toEqual(['steered:s1@1', 'steered:s2@1']);
    expect(
      log.filter((l) => l.op === 'persist').map((l) => l.event.payload),
    ).toEqual([{ text: '先说一句' }, { text: '再说一句' }]);
  });

  it('子 agent 命名空间里的不认；宿主没实现 steered 时忽略', async () => {
    const { sink } = recordingSink();
    const got: string[] = [];
    sink.steered = (id) => {
      got.push(id);
    };
    const [, mode, data] = steered('s9');
    await consumeAgentStream(
      streamOf([[['tools:abc'], mode, data]]),
      sink,
      opts(),
    );
    expect(got).toEqual([]);

    const plain = recordingSink();
    await consumeAgentStream(streamOf([steered('s1')]), plain.sink, opts());
    expect(plain.log).toEqual([]);
  });
});
