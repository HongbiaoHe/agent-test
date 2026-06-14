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
import { type DefaultEventsMap, Server, Socket } from 'socket.io';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from './stream.service';

interface SocketUser {
  userId: string;
  tenantId: string;
}

/** 挂在 socket.data 上的每连接状态（socket.io 第 4 个泛型）。 */
interface SocketData {
  user?: SocketUser;
  // 该 socket 已订阅的会话集合，用于「同 socket 同会话」订阅去重。
  subscribed?: Set<string>;
}

type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3100' },
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

  /** 连接时从 Authorization header 读 token（BFF middleware 注入，与 REST 统一），注入 socket.data.user。 */
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
      this.logger.warn('socket 鉴权失败，断开连接');
      socket.disconnect();
    }
  }

  /** 订阅会话事件流：校验会话属于该 socket 用户的租户。 */
  @SubscribeMessage('conversation:subscribe')
  async handleSubscribe(
    @MessageBody() body: { conversationId: string },
    @ConnectedSocket() socket: AppSocket,
  ) {
    const conversationId = body?.conversationId;
    const user = socket.data.user;
    if (!conversationId || !user) return { ok: false };

    // 同一 socket 对同一会话只保留一个 reader：socket 是单例长连接（切换会话不断连），
    // 前端每次切换都会重新 subscribe，若每次都新建 reader 会累积，导致同一事件被多次 emit。
    // 这里同步占位去重（含并发重订阅），鉴权失败再回滚。
    const subscribed = (socket.data.subscribed ??= new Set<string>());
    if (subscribed.has(conversationId)) return { ok: true };
    subscribed.add(conversationId);

    // 租户隔离：只能订阅自己租户的会话
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!conv) {
      subscribed.delete(conversationId);
      return { ok: false, reason: 'forbidden' };
    }

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
    @ConnectedSocket() socket: AppSocket,
  ) {
    const { conversationId, decisions } = body;
    const user = socket.data.user;
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
    if (cas.count === 0)
      return { ok: false, reason: 'already_resolved_or_forbidden' };

    const first = decisions[0] as { type?: string } | undefined;
    await this.prisma.approval.create({
      data: {
        conversationId,
        decision: first?.type ?? 'unknown',
        payload: decisions as Prisma.InputJsonValue,
      },
    });
    await this.queue.add('resume', {
      conversationId,
      kind: 'resume',
      decisions,
    });
    return { ok: true };
  }
}
