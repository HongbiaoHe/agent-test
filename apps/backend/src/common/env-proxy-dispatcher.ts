/**
 * 保住 Node 原生 fetch 的代理（NODE_USE_ENV_PROXY）不被 undici v8 覆盖。
 *
 * 现象（2026-10-17 实测）：默认提供方切到 E2B 后，每轮 agent 都在调 Gemini 时 `fetch failed`
 * （UND_ERR_CONNECT_TIMEOUT）；单独调 Gemini 正常。只要同一进程里调用过一次 E2B API 就复现。
 *
 * 原因：Node 22 开启 NODE_USE_ENV_PROXY 后，把 EnvHttpProxyAgent 放在全局槽位
 * `Symbol.for('undici.globalDispatcher.1')`，原生 fetch 从这里取 dispatcher。E2B SDK 首次请求时
 * 动态加载 npm 包 undici v8，v8 只看自己的槽位 `undici.globalDispatcher.2`——发现为空就
 * `setGlobalDispatcher(new Agent())`，**连旧槽位 .1 一起改写**成不走代理的 Agent
 * （node_modules/.pnpm/undici@8.x/lib/global.js）。从此原生 fetch 全部直连，被墙的 Gemini 超时。
 *
 * 处理：启动最早期把 Node 已有的 dispatcher 也登记到 .2 槽位，v8 加载时看到「已有全局 dispatcher」
 * 就不再覆盖。E2B 自己的请求传显式 dispatcher，不受影响（实测 list 照常）。没开代理时 .1 为空，
 * 本函数什么也不做，行为与之前一致。
 */

const LEGACY_SLOT = Symbol.for('undici.globalDispatcher.1');
const V2_SLOT = Symbol.for('undici.globalDispatcher.2');

/** @returns 是否做了登记（测试与启动日志用） */
export function pinEnvProxyDispatcher(
  target: Record<symbol, unknown> = globalThis,
): boolean {
  const current = target[LEGACY_SLOT];
  if (!current || target[V2_SLOT] !== undefined) return false;
  // 与 undici 自己的写法一致：可写、不可配置、不可枚举
  Object.defineProperty(target, V2_SLOT, {
    value: current,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  return true;
}
