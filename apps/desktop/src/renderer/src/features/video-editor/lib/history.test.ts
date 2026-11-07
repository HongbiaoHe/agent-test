import { describe, expect, it } from 'vitest';
import { createHistory, HISTORY_LIMIT, pushHistory, redoHistory, undoHistory } from './history';

describe('撤销栈', () => {
  it('push → undo → redo 往返', () => {
    let h = createHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2);
    expect(h.present).toBe(2);
    h = undoHistory(h);
    expect(h.present).toBe(1);
    h = undoHistory(h);
    expect(h.present).toBe(0);
    expect(undoHistory(h)).toBe(h);
    h = redoHistory(h);
    h = redoHistory(h);
    expect(h.present).toBe(2);
    expect(redoHistory(h)).toBe(h);
  });

  it('撤销后再编辑会清空 redo', () => {
    let h = pushHistory(pushHistory(createHistory('a'), 'b'), 'c');
    h = undoHistory(h);
    h = pushHistory(h, 'd');
    expect(h.future).toEqual([]);
    expect(h.past).toEqual(['a', 'b']);
  });

  it(`最多保留 ${HISTORY_LIMIT} 步，丢最早的`, () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = undoHistory(h);
    expect(h.present).toBe(20);
  });

  it('coalesce：连续改同一字段只算一步', () => {
    let h = createHistory(0);
    h = pushHistory(h, 1);
    h = pushHistory(h, 2, { coalesce: true });
    h = pushHistory(h, 3, { coalesce: true });
    expect(h.past).toEqual([0]);
    expect(undoHistory(h).present).toBe(0);
  });

  it('同一个对象不记步', () => {
    const v = { x: 1 };
    const h = createHistory(v);
    expect(pushHistory(h, v)).toBe(h);
  });
});
