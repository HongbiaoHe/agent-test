import { pinEnvProxyDispatcher } from './env-proxy-dispatcher';

const LEGACY = Symbol.for('undici.globalDispatcher.1');
const V2 = Symbol.for('undici.globalDispatcher.2');

/** 按 undici v8 global.js 的判定模拟它加载时的行为：.2 为空才新建 Agent 并覆盖 .1 */
function simulateUndiciV8Load(g: Record<symbol, unknown>) {
  if (g[V2] === undefined) {
    const fresh = { name: 'v8-agent-without-proxy' };
    g[V2] = fresh;
    g[LEGACY] = { wrapped: fresh };
  }
}

describe('pinEnvProxyDispatcher', () => {
  it('Node 已装代理 dispatcher → 登记到 v8 槽位，v8 加载后原生 fetch 仍走代理', () => {
    const envProxy = { name: 'EnvHttpProxyAgent' };
    const g: Record<symbol, unknown> = { [LEGACY]: envProxy };
    expect(pinEnvProxyDispatcher(g)).toBe(true);
    simulateUndiciV8Load(g);
    expect(g[LEGACY]).toBe(envProxy);
    expect(g[V2]).toBe(envProxy);
  });

  it('不登记时（对照组）v8 会把原生 fetch 的 dispatcher 换成不走代理的 Agent', () => {
    const envProxy = { name: 'EnvHttpProxyAgent' };
    const g: Record<symbol, unknown> = { [LEGACY]: envProxy };
    simulateUndiciV8Load(g);
    expect(g[LEGACY]).not.toBe(envProxy);
  });

  it('没开代理（.1 为空）或 .2 已有值 → 什么也不做', () => {
    const empty: Record<symbol, unknown> = {};
    expect(pinEnvProxyDispatcher(empty)).toBe(false);
    expect(empty[V2]).toBeUndefined();
    const existing = { name: 'already' };
    const g: Record<symbol, unknown> = { [LEGACY]: {}, [V2]: existing };
    expect(pinEnvProxyDispatcher(g)).toBe(false);
    expect(g[V2]).toBe(existing);
  });
});
