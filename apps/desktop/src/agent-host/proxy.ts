/**
 * 让 Node 原生 fetch（Gemini / DeepSeek / MCP SDK 都用它）走代理。
 *
 * Node 的 undici 默认不读 HTTPS_PROXY / HTTP_PROXY（仓库记忆：后端曾因此 `fetch failed`）。
 * main 进程启动 agent-host 时把代理放进 env（开发时继承终端的变量；打包后从系统代理解析），
 * 这里有代理就装一个全局 EnvHttpProxyAgent（尊重 NO_PROXY）。回环地址（本机 MCP server、
 * OAuth 回调）一律直连：补进 NO_PROXY。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export function installEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!proxy) return false;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of LOOPBACK) if (!noProxy.includes(h)) noProxy.push(h);
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: noProxy.join(',') }));
  return true;
}
