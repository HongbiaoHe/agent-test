import {
  historyFromRows,
  type HistoryRow,
  MAX_HISTORY_MESSAGES,
  roleOf,
} from './history';

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

describe('historyFromRows', () => {
  it('user / assistant 文本与 tool_end 结果按序重放；其它事件行不重放', async () => {
    const out = await historyFromRows(
      [
        row(0, 'user', 'message', { text: '你好' }),
        row(1, 'assistant', 'tool_start', { tool_calls: [] }),
        row(2, 'tool', 'tool_end', { name: 'search', content: '{"r":1}' }),
        row(3, 'assistant', 'reasoning', { text: '想' }),
        row(4, 'assistant', 'message', { text: '答案' }),
        row(5, 'assistant', 'result', { status: 'done' }),
      ],
      plainUserText,
    );
    expect(out).toEqual([
      { role: 'user', content: '你好' },
      { role: 'tool', content: '{"r":1}', tool_call_id: 'synth_search_2' },
      { role: 'assistant', content: '答案' },
    ]);
  });

  it('用户正文由宿主决定（可异步）', async () => {
    const out = await historyFromRows(
      [row(0, 'user', 'message', { text: 'x' })],
      () => Promise.resolve('x\n\n[附件]\n- a.png'),
    );
    expect(out[0].content).toBe('x\n\n[附件]\n- a.png');
  });

  it('非字符串工具结果序列化；没名字 / 没内容 / 形状不对都有兜底', async () => {
    const out = await historyFromRows(
      [
        row(0, 'user', 'message', { text: 'q' }),
        row(1, 'tool', 'tool_end', { name: 'a', content: [{ type: 'text' }] }),
        row(2, 'tool', 'tool_end', { content: 'ok' }),
        row(3, 'tool', 'tool_end', {}),
        row(4, 'tool', 'tool_end', 'not-an-object'),
      ],
      plainUserText,
    );
    expect(out.slice(1)).toEqual([
      { role: 'tool', content: '[{"type":"text"}]', tool_call_id: 'synth_a_1' },
      { role: 'tool', content: 'ok', tool_call_id: 'synth_tool_2' },
      { role: 'tool', content: '', tool_call_id: 'synth_tool_3' },
      { role: 'tool', content: '', tool_call_id: 'synth_tool_4' },
    ]);
  });

  it('只取最近 200 条，且从头部去掉非 user 行（对话起点必须是用户）', async () => {
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 250; i++) {
      rows.push(
        row(i, i % 2 ? 'assistant' : 'user', 'message', { text: `m${i}` }),
      );
    }
    const out = await historyFromRows(rows, plainUserText);
    // 最近 200 条从 m50（user）开始
    expect(out).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(out[0]).toEqual({ role: 'user', content: 'm50' });

    const odd = await historyFromRows(rows.slice(1, 11), plainUserText);
    // 首条是 assistant（m1）→ 去掉，从 m2 开始
    expect(odd[0]).toEqual({ role: 'user', content: 'm2' });
    expect(odd).toHaveLength(9);
  });
});

describe('roleOf', () => {
  it('按事件类型给 role；reasoning 是 assistant，tool_end 是 tool，未登记的按 assistant', () => {
    expect(roleOf('tool_end')).toBe('tool');
    expect(roleOf('reasoning')).toBe('assistant');
    expect(roleOf('something_new')).toBe('assistant');
  });
});
