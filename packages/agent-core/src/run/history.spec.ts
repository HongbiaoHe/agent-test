import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { historyFromRows, type HistoryRow, roleOf } from './history';

const row = (
  seq: number,
  role: string,
  type: string,
  content: unknown,
): HistoryRow => ({ seq, role, type, content });

const plainUserText = (content: unknown) =>
  typeof content === 'object' && content !== null && 'text' in content
    ? String(content.text)
    : '';

/** 消息的可比较形状：类型 + 正文 + 工具调用 id / 工具结果 id */
function shape(m: BaseMessage): string {
  if (ToolMessage.isInstance(m))
    return `tool(${m.tool_call_id},${m.name}):${m.text}`;
  if (AIMessage.isInstance(m) && m.tool_calls?.length) {
    return `ai:${m.text}+[${m.tool_calls.map((c) => `${c.id}:${c.name}`).join(',')}]`;
  }
  return `${m.getType()}:${m.text}`;
}

async function replay(rows: HistoryRow[]) {
  const h = await historyFromRows(rows, plainUserText);
  return { ...h, shapes: h.entries.map((e) => shape(e.message)) };
}

describe('historyFromRows', () => {
  it('工具调用与结果成对重建：前导正文并进同一条 AIMessage，结果紧跟其后；其它事件行不重放', async () => {
    const { shapes } = await replay([
      row(0, 'user', 'message', { text: '你好' }),
      row(1, 'assistant', 'message', { text: '我查一下' }),
      row(2, 'assistant', 'tool_start', {
        tool_calls: [{ id: 'c1', name: 'search', args: { q: 'x' } }],
      }),
      row(3, 'assistant', 'reasoning', { text: '想' }),
      row(4, 'tool', 'tool_end', {
        name: 'search',
        content: '{"r":1}',
        toolCallId: 'c1',
      }),
      row(5, 'assistant', 'message', { text: '答案' }),
      row(6, 'assistant', 'result', { status: 'done' }),
    ]);
    expect(shapes).toEqual([
      'human:你好',
      'ai:我查一下+[c1:search]',
      'tool(c1,search):{"r":1}',
      'ai:答案',
    ]);
  });

  it('没拿到结果的调用丢掉（停止 / 拒绝）；孤立结果（旧数据无 toolCallId）不重放', async () => {
    const { shapes } = await replay([
      row(0, 'user', 'message', { text: 'q' }),
      row(1, 'assistant', 'tool_start', {
        tool_calls: [
          { id: 'a', name: 'x', args: {} },
          { id: 'b', name: 'y', args: {} },
        ],
      }),
      row(2, 'tool', 'tool_end', { name: 'x', content: 'ok', toolCallId: 'a' }),
      row(3, 'tool', 'tool_end', { name: 'z', content: 'legacy' }),
      row(4, 'assistant', 'tool_start', {
        tool_calls: [{ id: 'c', name: 'w', args: {} }],
      }),
      row(5, 'assistant', 'message', { text: '完' }),
    ]);
    expect(shapes).toEqual(['human:q', 'ai:+[a:x]', 'tool(a,x):ok', 'ai:完']);
  });

  it('审批续跑重发的同 id tool_start 并进同一分组、换成最终参数', async () => {
    const { entries } = await replay([
      row(0, 'user', 'message', { text: 'q' }),
      row(1, 'assistant', 'tool_start', {
        tool_calls: [{ id: 'm', name: 'mail', args: { to: 'a' } }],
      }),
      row(2, 'assistant', 'control_request', {}),
      row(3, 'assistant', 'tool_start', {
        tool_calls: [{ id: 'm', name: 'mail', args: { to: 'b' } }],
      }),
      row(4, 'tool', 'tool_end', {
        name: 'mail',
        content: 'sent',
        toolCallId: 'm',
      }),
    ]);
    const ai = entries[1].message;
    expect(AIMessage.isInstance(ai) && ai.tool_calls?.[0].args).toEqual({
      to: 'b',
    });
    expect(entries).toHaveLength(3);
  });

  it('子 agent 的内部事件不重放，task 的最终结果照常配对', async () => {
    const sub = { callId: 't1', name: 'writer' };
    const { shapes } = await replay([
      row(0, 'user', 'message', { text: 'q' }),
      row(1, 'assistant', 'tool_start', {
        tool_calls: [{ id: 't1', name: 'task', args: {} }],
      }),
      row(2, 'assistant', 'message', { text: '子 agent 正文', subagent: sub }),
      row(3, 'assistant', 'tool_start', {
        tool_calls: [{ id: 's1', name: 'read_file', args: {} }],
        subagent: sub,
      }),
      row(4, 'tool', 'tool_end', {
        name: 'read_file',
        content: 'x',
        toolCallId: 's1',
        subagent: sub,
      }),
      row(5, 'tool', 'tool_end', {
        name: 'task',
        content: '最终稿',
        toolCallId: 't1',
      }),
    ]);
    expect(shapes).toEqual([
      'human:q',
      'ai:+[t1:task]',
      'tool(t1,task):最终稿',
    ]);
  });

  it('非字符串工具结果：文字块保留，其它块换成说明（不把 base64 当文本重放）', async () => {
    const { shapes } = await replay([
      row(0, 'user', 'message', { text: 'q' }),
      row(1, 'assistant', 'tool_start', {
        tool_calls: [{ id: 'r', name: 'read_file', args: {} }],
      }),
      row(2, 'tool', 'tool_end', {
        name: 'read_file',
        toolCallId: 'r',
        content: [
          { type: 'text', text: '图片：' },
          { type: 'image', data: 'AAAA' },
        ],
      }),
    ]);
    expect(shapes[2]).toBe('tool(r,read_file):图片：\n[非文本内容已省略]');
  });

  it('摘要之前的行不重放；userTexts 仍含全部用户轮次（/command 技能激活要看）', async () => {
    const h = await replay([
      row(0, 'user', 'message', { text: '/tvc 做广告' }),
      row(1, 'assistant', 'message', { text: '好' }),
      row(2, 'user', 'message', { text: '继续' }),
      row(3, 'system', 'context_summary', { text: '早前摘要', uptoSeq: 1 }),
      row(4, 'assistant', 'message', { text: '在做' }),
    ]);
    expect(h.summary).toEqual({ text: '早前摘要', uptoSeq: 1 });
    expect(h.shapes).toEqual(['human:继续', 'ai:在做']);
    expect(h.userTexts).toEqual(['/tvc 做广告', '继续']);
  });

  it('对话起点必须是用户；用户正文由宿主决定（可异步）', async () => {
    const h = await historyFromRows(
      [
        row(0, 'assistant', 'message', { text: '欢迎' }),
        row(1, 'user', 'message', { text: 'x' }),
      ],
      () => Promise.resolve('x\n\n[附件]\n- a.png'),
    );
    expect(h.entries).toHaveLength(1);
    expect(HumanMessage.isInstance(h.entries[0].message)).toBe(true);
    expect(h.entries[0].message.text).toBe('x\n\n[附件]\n- a.png');
  });
});

describe('roleOf', () => {
  it('按事件类型给 role；reasoning 是 assistant，tool_end 是 tool，摘要是 system，未登记的按 assistant', () => {
    expect(roleOf('tool_end')).toBe('tool');
    expect(roleOf('reasoning')).toBe('assistant');
    expect(roleOf('context_summary')).toBe('system');
    expect(roleOf('something_new')).toBe('assistant');
  });
});
