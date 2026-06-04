import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CommandRegistryService } from '../commands/command-registry.service';
import { parseCommand } from '../commands/parse-command';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandRegistryService,
    @InjectQueue('agent-run') private readonly queue: Queue,
  ) {}

  /** 若是 /command，校验命令存在；未知则报错（worker 运行时再注入对应技能正文）。 */
  private assertKnownCommand(text: string) {
    const cmd = parseCommand(text);
    if (cmd && !this.commands.get(cmd.name)) {
      throw new BusinessException(ErrorCodes.COMMAND_NOT_FOUND);
    }
  }

  async create(
    goal: string,
    tenantId: string,
    userId: string,
    model?: string,
  ) {
    if (!goal?.trim()) {
      throw new BusinessException(ErrorCodes.CONVERSATION_GOAL_EMPTY);
    }
    this.assertKnownCommand(goal);
    const conv = await this.prisma.conversation.create({
      data: { goal, status: 'queued', tenantId, userId, model },
    });
    // 把首轮目标落成 user message（seq 0），与追加轮统一；worker 每轮从 DB 重放完整对话历史
    await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'user',
        type: 'message',
        content: { text: goal },
        seq: 0,
      },
    });
    await this.queue.add('run', { conversationId: conv.id, goal });
    return { conversationId: conv.id };
  }

  /**
   * 在已有会话里追加一条用户消息并续跑（多轮对话）。
   * 同一个 thread_id（= 会话 id）+ checkpointer，agent 自动带上历史上下文。
   */
  async appendMessage(
    id: string,
    content: string,
    tenantId: string,
    model?: string,
  ) {
    if (!content?.trim()) {
      throw new BusinessException(ErrorCodes.CONVERSATION_GOAL_EMPTY);
    }
    this.assertKnownCommand(content);
    // 租户隔离：只能往自己租户的会话追加
    const conv = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!conv) {
      throw new BusinessException(
        ErrorCodes.CONVERSATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    // 并发守卫：仅在空闲（done/failed）时允许追加，避免对同一 thread 并发续跑
    if (conv.status !== 'done' && conv.status !== 'failed') {
      throw new BusinessException(ErrorCodes.CONVERSATION_BUSY);
    }

    // 本轮选定的模型落到会话上，worker 据此续跑（含审批 resume / 超时兜底都复用同一模型）
    if (model) {
      await this.prisma.conversation.update({
        where: { id },
        data: { model },
      });
    }

    // 落一条 user message（seq 接续，worker 续跑时再从当前 count 接着排）
    const seq = await this.prisma.message.count({
      where: { conversationId: id },
    });
    await this.prisma.message.create({
      data: {
        conversationId: id,
        role: 'user',
        type: 'message',
        content: { text: content },
        seq,
      },
    });

    // 复用 'run'：worker 用 { messages:[新用户消息] } + 同 thread_id 续跑
    await this.queue.add('run', { conversationId: id, goal: content });
    return { conversationId: id };
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
