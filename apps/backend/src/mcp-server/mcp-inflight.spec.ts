import { InflightCalls } from './mcp-inflight';

describe('InflightCalls（客户端取消通知 → 中止原调用）', () => {
  it('登记过的调用能被取消；结束后释放，再取消不再命中', () => {
    const calls = new InflightCalls();
    const a = new AbortController();
    calls.register(['g|ip|3'], a);
    expect(calls.cancel('g|ip|3')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    calls.release(['g|ip|3'], a);
    expect(calls.cancel('g|ip|3')).toBe(false);
  });

  it('两个客户端撞了同一个 key：认不出是谁，谁都不停', () => {
    const calls = new InflightCalls();
    const a = new AbortController();
    const b = new AbortController();
    calls.register(['g|ip|3'], a);
    calls.register(['g|ip|3'], b);
    expect(calls.cancel('g|ip|3')).toBe(false);
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    // 其中一个结束后歧义解除，剩下那个可以被取消
    calls.release(['g|ip|3'], a);
    expect(calls.cancel('g|ip|3')).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('没登记的 key 取消无效', () => {
    expect(new InflightCalls().cancel('nope')).toBe(false);
  });
});
