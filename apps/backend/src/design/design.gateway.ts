import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { type DefaultEventsMap, Socket } from 'socket.io';
import { StreamService } from '../events/stream.service';
import { PrismaService } from '../prisma/prisma.service';

interface SocketData {
  user?: { userId: string; tenantId: string };
  subscribed?: Set<string>;
}
type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

/**
 * 设计稿实时网关：独立 namespace `/design`（与对话、画布的网关互不影响）。
 * design:subscribe → 推送 design_patch / design_focus / design_status 与 agent 的流式事件。
 */
@WebSocketGateway({
  namespace: '/design',
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3100' },
})
export class DesignGateway implements OnGatewayConnection {
  private readonly logger = new Logger(DesignGateway.name);

  constructor(
    private readonly stream: StreamService,
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
      this.logger.warn('design socket 鉴权失败，断开连接');
      socket.disconnect();
    }
  }

  @SubscribeMessage('design:subscribe')
  async handleSubscribe(
    @MessageBody() body: { docId: string },
    @ConnectedSocket() socket: AppSocket,
  ) {
    const docId = body?.docId;
    const user = socket.data.user;
    if (!docId || !user) return { ok: false };
    const subscribed = (socket.data.subscribed ??= new Set<string>());
    if (subscribed.has(docId)) return { ok: true };
    subscribed.add(docId);
    const doc = await this.prisma.designDoc.findFirst({
      where: { id: docId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!doc) {
      subscribed.delete(docId);
      return { ok: false, reason: 'forbidden' };
    }
    let stopped = false;
    socket.on('disconnect', () => {
      stopped = true;
    });
    // 从 '$' 起只推订阅后的新事件；快照与历史由 REST 提供
    void this.stream.subscribe(
      docId,
      (evt) => socket.emit('design:event', evt),
      () => stopped,
      '$',
    );
    return { ok: true };
  }
}
