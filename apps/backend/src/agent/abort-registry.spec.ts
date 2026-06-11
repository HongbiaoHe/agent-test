/**
 * AbortRegistry 单测：注册/中止/dispose 配对语义（停止功能的竞态基石）。
 */
import { AbortRegistry } from './abort-registry';

describe('AbortRegistry', () => {
  let reg: AbortRegistry;

  beforeEach(() => {
    reg = new AbortRegistry();
  });

  it('register 返回未中止的 signal；abort 后 signal.aborted = true 且返回 true', () => {
    const { signal } = reg.register('c1');
    expect(signal.aborted).toBe(false);
    expect(reg.abort('c1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it('未注册的 key abort 返回 false（没在跑）', () => {
    expect(reg.abort('nope')).toBe(false);
  });

  it('abort 后再次 abort 返回 false（已移除，幂等）', () => {
    reg.register('c1');
    expect(reg.abort('c1')).toBe(true);
    expect(reg.abort('c1')).toBe(false);
  });

  it('dispose 后 abort 返回 false（正常结束后停不到东西）', () => {
    const { dispose } = reg.register('c1');
    dispose();
    expect(reg.abort('c1')).toBe(false);
  });

  it('同 key 覆盖注册后，旧句柄 dispose 不误删新注册', () => {
    const first = reg.register('c1');
    const second = reg.register('c1'); // 覆盖（如 timeout job 与 resume run 共存场景）
    first.dispose(); // 旧句柄清理
    // 新注册仍在：abort 命中 second 的 controller
    expect(reg.abort('c1')).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it('abort 只影响对应 key', () => {
    const a = reg.register('a');
    const b = reg.register('b');
    reg.abort('a');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});
