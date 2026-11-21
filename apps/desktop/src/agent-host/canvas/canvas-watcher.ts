/**
 * 画布实时事件转发：agent-host 带 Web 账号令牌连 Web 后端的 socket.io `/canvas` 命名空间，只订阅界面上
 * 打开着的画布，把与画布投影有关的事件经 RPC 事件推给画布视图（renderer 不直连后端、不持有令牌）。
 *
 * 服务端的订阅没有「退订」：一块画布一条连接，没人看了就断开。连接断开重连后推一个 resync，
 * 画布视图据此重拉快照（断线期间的增量没收到）。
 */
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import type { CanvasStreamEvent } from '../../shared/canvas';
import type { WebApi } from '../web-media/web-api';

/** 转发的事件：增量直接应用，其余让视图重拉快照 */
const FORWARDED = new Set(['canvas_patch', 'canvas_lock', 'media_update', 'result', 'error']);

const eventSchema = z.object({ type: z.string(), payload: z.unknown().optional() });

interface Watch {
  socket: Socket;
  /** 同一块画布可能被多个视图打开（不同窗口）：最后一个关掉才断开 */
  refs: number;
}

export class CanvasWatcher {
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly web: WebApi,
    private readonly emit: (canvasId: string, event: CanvasStreamEvent) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  watch(canvasId: string): void {
    const cur = this.watches.get(canvasId);
    if (cur) {
      cur.refs += 1;
      return;
    }
    const socket = io(`${this.web.baseUrl}/canvas`, {
      transports: ['websocket'],
      extraHeaders: { Authorization: this.web.bearer },
    });
    let connectedOnce = false;
    socket.on('connect', () => {
      socket.emit('canvas:subscribe', { sessionId: canvasId });
      // 重连：断线期间的增量收不到了，让视图重拉一次快照
      if (connectedOnce) this.emit(canvasId, { type: 'resync' });
      connectedOnce = true;
    });
    socket.on('connect_error', (e: Error) => this.log(`画布实时连接失败 canvas=${canvasId}: ${e.message}`));
    socket.on('canvas:event', (raw: unknown) => {
      const evt = eventSchema.safeParse(raw);
      if (!evt.success || !FORWARDED.has(evt.data.type)) return;
      this.emit(canvasId, { type: evt.data.type, payload: evt.data.payload ?? null });
    });
    this.watches.set(canvasId, { socket, refs: 1 });
  }

  unwatch(canvasId: string): void {
    const cur = this.watches.get(canvasId);
    if (!cur) return;
    cur.refs -= 1;
    if (cur.refs > 0) return;
    cur.socket.disconnect();
    this.watches.delete(canvasId);
  }

  closeAll(): void {
    for (const w of this.watches.values()) w.socket.disconnect();
    this.watches.clear();
  }
}
