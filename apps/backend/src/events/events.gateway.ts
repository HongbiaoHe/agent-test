import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Queue } from 'bullmq';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from './stream.service';

interface SocketUser {
  userId: string;
  tenantId: string;
}

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' },
})
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly stream: StreamService,
    @InjectQueue('agent-run') private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** 连接时验证 handshake.auth.token（与 REST 同一个 JWT），注入 socket.data.user。 */
  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      socket.disconnect();
      return;
    }
    try {
      const p = await this.jwt.verifyAsync(token);
      socket.data.user = { userId: p.sub, tenantId: p.tenantId } as SocketUser;
    } catch {
      this.logger.warn('socket 鉴权失败，断开连接');
      socket.disconnect();
    }
  }

  /** 订阅会话事件流：校验会话属于该 socket 用户的租户。 */
  @SubscribeMessage('conversation:subscribe')
  async handleSubscribe(
    @MessageBody() body: { conversationId: string },
    @ConnectedSocket() socket: Socket,
  ) {
    const conversationId = body?.conversationId;
    const user = socket.data.user as SocketUser | undefined;
    if (!conversationId || !user) return { ok: false };

    // 租户隔离：只能订阅自己租户的会话
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!conv) return { ok: false, reason: 'forbidden' };

    let stopped = false;
    socket.on('disconnect', () => {
      stopped = true;
    });
    // 从 '$' 起只推订阅之后的新增事件：历史由前端 GET /conversations/:id 提供，
    // 二者不重叠，避免历史 + 回放重复渲染同一批事件。
    void this.stream.subscribe(
      conversationId,
      (evt) => socket.emit('conversation:event', evt),
      () => stopped,
      '$',
    );
    return { ok: true };
  }

  /** 审批决策：CAS 带 tenantId 过滤（租户隔离 + 幂等），成功才入队 resume job。 */
  @SubscribeMessage('control:response')
  async handleControlResponse(
    @MessageBody() body: { conversationId: string; decisions: unknown[] },
    @ConnectedSocket() socket: Socket,
  ) {
    const { conversationId, decisions } = body;
    const user = socket.data.user as SocketUser | undefined;
    if (!conversationId || !Array.isArray(decisions) || !user) {
      return { ok: false };
    }

    const cas = await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        tenantId: user.tenantId,
        status: 'waiting_approval',
      },
      data: { status: 'running' },
    });
    if (cas.count === 0) return { ok: false, reason: 'already_resolved_or_forbidden' };

    const first = decisions[0] as { type?: string } | undefined;
    await this.prisma.approval.create({
      data: {
        conversationId,
        decision: first?.type ?? 'unknown',
        payload: decisions as object,
      },
    });
    await this.queue.add('resume', { conversationId, kind: 'resume', decisions });
    return { ok: true };
  }
}
