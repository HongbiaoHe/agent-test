import { planHistoryWindow } from './history-window';

/**
 * 造 n 条消息，贴近真实 run 的形状：每 10 条起一轮新对话（user 开头，其余 assistant/tool 交替）。
 */
const rows = (n: number, startSeq = 0) =>
  Array.from({ length: n }, (_, i) => ({
    seq: startSeq + i,
    role: i % 10 === 0 ? 'user' : i % 2 === 1 ? 'assistant' : 'tool',
  }));

describe('planHistoryWindow', () => {
  it('未到硬上限 → 原样重放，且不动基点（前缀逐字不变）', () => {
    const { slice, nextBaseSeq } = planHistoryWindow(rows(300));
    expect(slice).toHaveLength(300);
    expect(nextBaseSeq).toBeNull();
  });

  it('冲破硬上限 → 重整一次并回写新基点', () => {
    const { slice, nextBaseSeq } = planHistoryWindow(rows(301));
    expect(slice.length).toBeLessThanOrEqual(200);
    expect(slice[0].role).toBe('user');
    expect(nextBaseSeq).toBe(slice[0].seq);
  });

  it('首条不是 user 时掐头，掐到的位置即新基点（下次不会再漂）', () => {
    const input = [
      { seq: 10, role: 'assistant' },
      { seq: 11, role: 'tool' },
      ...rows(400, 12),
    ];
    const { slice, nextBaseSeq } = planHistoryWindow(input);
    expect(slice[0].role).toBe('user');
    expect(nextBaseSeq).toBe(slice[0].seq);
  });

  it('窗口内没有 user 消息（长工具链）→ 退回整段，绝不把历史掐空', () => {
    const input = [
      { seq: 0, role: 'user' },
      ...Array.from({ length: 400 }, (_, i) => ({
        seq: i + 1,
        role: i % 2 === 0 ? 'assistant' : 'tool',
      })),
    ];
    const { slice } = planHistoryWindow(input);
    expect(slice).toHaveLength(401);
    expect(slice[0].seq).toBe(0);
  });

  /**
   * 回归护栏：这正是旧实现（每轮 slice(-200)）做不到的 —— 那时每加一条消息头部就前移一格，
   * 重放出来的历史头部逐轮不同，整段前缀从第一个 token 起就对不上。
   */
  it('重整后持续增长：基点钉住不动，历史头部逐字不变', () => {
    let baseSeq = 0;
    let head: number | undefined;

    // 从 301 条起每轮再加 10 条，连跑 9 轮（涨到 ~390 条，未再破上限）
    for (let round = 0; round < 9; round += 1) {
      const visible = rows(301 + round * 10).filter((r) => r.seq >= baseSeq);
      const { slice, nextBaseSeq } = planHistoryWindow(visible);
      if (nextBaseSeq !== null) baseSeq = nextBaseSeq;

      if (head === undefined) head = slice[0].seq;
      else expect(slice[0].seq).toBe(head); // 头部纹丝不动
    }
    expect(baseSeq).toBe(head); // 只在第一轮重整过一次，之后基点再没动
  });
});
