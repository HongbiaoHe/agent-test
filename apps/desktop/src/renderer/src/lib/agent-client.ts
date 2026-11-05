/**
 * renderer 侧的 agent-host 客户端：经 MessagePort 发 RPC、收流式事件。
 *
 * 端口由 preload 以 window.postMessage 转交（见 src/preload/index.ts）。agent-host 重启（改 Key、崩溃）
 * 时 main 会发来新端口：未完成的请求以「agent 进程已重启」失败，订阅者收到 reconnected 后自行刷新。
 */
import { z } from 'zod';
import { AGENT_PORT_CLOSED_MESSAGE, AGENT_PORT_MESSAGE } from '../../../shared/desktop';
import type { HostEvent, RpcMethod, RpcParams, RpcResults } from '../../../shared/rpc';

type Listener = (e: HostEvent | { kind: 'reconnected' }) => void;

const responseSchema = z.discriminatedUnion('ok', [
  z.object({ kind: z.literal('response'), id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('response'), id: z.number(), ok: z.literal(false), error: z.string() }),
]);
const eventSchema = z.discriminatedUnion('type', [
  z.object({
    kind: z.literal('event'),
    type: z.literal('conversation'),
    conversationId: z.string(),
    event: z.object({ type: z.string(), payload: z.unknown(), ts: z.number() }),
  }),
  z.object({ kind: z.literal('event'), type: z.literal('conversations-changed') }),
  z.object({ kind: z.literal('event'), type: z.literal('mcp-changed') }),
  z.object({ kind: z.literal('event'), type: z.literal('skills-changed') }),
  z.object({
    kind: z.literal('event'),
    type: z.literal('mcp-oauth'),
    ok: z.boolean(),
    serverId: z.string().optional(),
    error: z.string().optional(),
  }),
]);

class AgentClient {
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  private waiters: ((p: MessagePort) => void)[] = [];
  private reconnecting = false;

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.data === AGENT_PORT_MESSAGE && e.ports[0]) this.setPort(e.ports[0]);
      if (e.data === AGENT_PORT_CLOSED_MESSAGE) this.dropPort();
    });
    window.desktopAgent.requestPort();
  }

  /** agent-host 要重启了：已发出的请求失败，之后的请求排队等新端口 */
  private dropPort(): void {
    if (!this.port) return;
    this.port.close();
    this.port = null;
    this.reconnecting = true;
    for (const p of this.pending.values()) p.reject(new Error('agent 进程已重启，请重试'));
    this.pending.clear();
  }

  private setPort(port: MessagePort): void {
    const hadPort = this.port !== null || this.reconnecting;
    this.reconnecting = false;
    this.port?.close();
    for (const p of this.pending.values()) p.reject(new Error('agent 进程已重启，请重试'));
    this.pending.clear();
    this.port = port;
    port.onmessage = (e: MessageEvent<unknown>) => this.onMessage(e.data);
    port.start();
    for (const w of this.waiters) w(port);
    this.waiters = [];
    if (hadPort) for (const l of this.listeners) l({ kind: 'reconnected' });
  }

  private onMessage(data: unknown): void {
    const res = responseSchema.safeParse(data);
    if (res.success) {
      const p = this.pending.get(res.data.id);
      if (!p) return;
      this.pending.delete(res.data.id);
      if (res.data.ok) p.resolve(res.data.result);
      else p.reject(new Error(res.data.error));
      return;
    }
    const evt = eventSchema.safeParse(data);
    if (evt.success) for (const l of this.listeners) l(evt.data);
  }

  private ready(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const port = await this.ready();
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      port.postMessage({ kind: 'request', id, method, params });
    });
    // 结果由 agent-host 的同名处理函数产出（rpc-server.ts 的 Handlers 按 RpcResults 约束了返回类型），
    // 经结构化克隆原样到达；这里是跨进程边界唯一的断言点
    return result as RpcResults[M];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const agent = new AgentClient();
