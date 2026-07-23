import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Queue } from 'bullmq';
import { type DefaultEventsMap, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';

interface SocketUser {
  userId: string;
  tenantId: string;
}
interface SocketData {
  user?: SocketUser;
  subscribed?: Set<string>;
}
type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

/**
 * 画布实时网关：独立 socket.io namespace `/canvas`，与现有 EventsGateway（默认 namespace）
 * 完全隔离——各自 handleConnection / 事件名，互不影响。事件：
 *  - canvas:subscribe        订阅画布事件流（token/message/tool/plan/canvas_patch/token_usage/control_request/result）
 *  - canvas:control:response ask_user 回答 → resume 续跑
 */
@WebSocketGateway({
  namespace: '/canvas',
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3100' },
})
export class CanvasGateway implements OnGatewayConnection {
  private readonly logger = new Logger(CanvasGateway.name);

  constructor(
    private readonly stream: StreamService,
    @InjectQueue('canvas-run') private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async handleConnection(socket: AppSocket) {
    const header = socket.handshake.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      socket.disconnect();
      return;
    }
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; tenantId: string }>(
        header.slice(7),
      );
      socket.data.user = { userId: p.sub, tenantId: p.tenantId };
    } catch {
      this.logger.warn('canvas socket 鉴权失败，断开连接');
      socket.disconnect();
    }
  }

  @SubscribeMessage('canvas:subscribe')
  async handleSubscribe(
    @MessageBody() body: { sessionId: string },
    @ConnectedSocket() socket: AppSocket,
  ) {
    const sessionId = body?.sessionId;
    const user = socket.data.user;
    if (!sessionId || !user) return { ok: false };

    const subscribed = (socket.data.subscribed ??= new Set<string>());
    if (subscribed.has(sessionId)) return { ok: true };
    subscribed.add(sessionId);

    const session = await this.prisma.canvasSession.findFirst({
      where: { id: sessionId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!session) {
      subscribed.delete(sessionId);
      return { ok: false, reason: 'forbidden' };
    }

    let stopped = false;
    socket.on('disconnect', () => {
      stopped = true;
    });
    // 从 '$' 起只推订阅后的新事件；历史由 REST 快照 + GET messages 提供，不重叠。
    void this.stream.subscribe(
      sessionId,
      (evt) => socket.emit('canvas:event', evt),
      () => stopped,
      '$',
    );
    return { ok: true };
  }

  @SubscribeMessage('canvas:control:response')
  async handleControlResponse(
    @MessageBody() body: { sessionId: string; decisions: unknown[] },
    @ConnectedSocket() socket: AppSocket,
  ) {
    const { sessionId, decisions } = body;
    const user = socket.data.user;
    if (!sessionId || !Array.isArray(decisions) || !user) {
      return { ok: false };
    }
    const cas = await this.prisma.canvasSession.updateMany({
      where: {
        id: sessionId,
        tenantId: user.tenantId,
        status: 'waiting_approval',
      },
      data: { status: 'running' },
    });
    if (cas.count === 0) {
      return { ok: false, reason: 'already_resolved_or_forbidden' };
    }
    await this.queue.add('resume', { sessionId, kind: 'resume', decisions });
    return { ok: true };
  }
}
