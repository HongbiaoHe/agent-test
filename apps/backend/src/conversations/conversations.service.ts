import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('agent-run') private readonly queue: Queue,
  ) {}

  async create(goal: string, tenantId: string, userId: string) {
    if (!goal?.trim()) {
      throw new BusinessException(ErrorCodes.CONVERSATION_GOAL_EMPTY);
    }
    const conv = await this.prisma.conversation.create({
      data: { goal, status: 'queued', tenantId, userId },
    });
    await this.queue.add('run', { conversationId: conv.id, goal });
    return { conversationId: conv.id };
  }

  /** 列出当前租户的会话（SSR 列表用）。 */
  async list(tenantId: string) {
    return this.prisma.conversation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, goal: true, status: true, createdAt: true },
    });
  }

  /** 按 tenantId 过滤，保证只能查到自己租户的会话（多租户隔离）。 */
  async findOne(id: string, tenantId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      include: { messages: { orderBy: { seq: 'asc' } } },
    });
    if (!conv) {
      throw new BusinessException(
        ErrorCodes.CONVERSATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return conv;
  }
}
