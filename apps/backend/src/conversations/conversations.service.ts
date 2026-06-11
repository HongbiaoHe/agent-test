import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { AbortRegistry, AGENT_ABORTS } from '../agent/abort-registry';
import { parseCommand } from '../commands/parse-command';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { assertSafeEntryPath } from '../skills/skill-installer';
import { findUserSandbox } from '../agent/sandbox';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    @InjectQueue('agent-run') private readonly queue: Queue,
    private readonly stream: StreamService,
    private readonly media: MediaService,
    @Inject(AGENT_ABORTS) private readonly aborts: AbortRegistry,
  ) {}

  /**
   * 若是 /command，校验对该用户有效的技能中存在对应命令；
   * 未知则报错（worker 运行时再注入对应技能正文）。
   * 数据源已从静态 CommandRegistryService 切换为 SkillsService（内置 + 用户安装合并）。
   */
  private async assertKnownCommand(text: string, userId: string) {
    const cmd = parseCommand(text);
    if (cmd && !(await this.skills.getFor(userId, cmd.name))) {
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
    await this.assertKnownCommand(goal, userId);
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
    userId: string,
    model?: string,
  ) {
    if (!content?.trim()) {
      throw new BusinessException(ErrorCodes.CONVERSATION_GOAL_EMPTY);
    }
    await this.assertKnownCommand(content, userId);
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
    // 并发守卫：仅在空闲（done/failed/stopped）时允许追加，避免对同一 thread 并发续跑
    if (
      conv.status !== 'done' &&
      conv.status !== 'failed' &&
      conv.status !== 'stopped'
    ) {
      throw new BusinessException(ErrorCodes.CONVERSATION_BUSY);
    }

    // 状态重置为 queued（必须）：上一轮若是 stopped 终态，不重置会让新 job 撞 worker 的
    // CAS 门（where status != 'stopped'）被误判「排队期间被停止」——一次停止永久封死会话。
    // 顺带把本轮选定的模型落到会话上（含审批 resume / 超时兜底都复用同一模型）。
    await this.prisma.conversation.update({
      where: { id },
      data: { status: 'queued', ...(model ? { model } : {}) },
    });

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

  /**
   * 主动停止当前运行（设计见 docs/superpowers/specs/2026-06-11-stop-run-design.md）。
   *
   * 竞态规则（result 事件恰好一份）：abort() 返回 true ⇒ worker 一定观察到
   * signal.aborted，由 worker 发停止收尾事件；false ⇒ worker 未注册（排队/审批中
   * 无 worker 在跑）或已结束，由这里按 CAS 命中数补发。幂等：重复停/已结束 → stopped:false。
   */
  async stop(id: string, tenantId: string) {
    await this.assertConversationOwner(id, tenantId);

    const aborted = this.aborts.abort(id);
    // 会话级取消媒体任务（含上一轮仍在生成中的视频——「停止所有操作」的有意语义）
    await this.media.cancelByConversation(id);

    const cas = await this.prisma.conversation.updateMany({
      where: { id, status: { in: ['queued', 'running', 'waiting_approval'] } },
      data: { status: 'stopped' },
    });

    if (!aborted && cas.count > 0) {
      const seq = await this.prisma.message.count({
        where: { conversationId: id },
      });
      const payload = { status: 'stopped' };
      await this.stream.publish(id, { type: 'result', payload });
      // role 与 worker 的 ROLE_BY_TYPE 一致（result → assistant），历史回放行为统一
      await this.prisma.message.create({
        data: { conversationId: id, role: 'assistant', type: 'result', content: payload, seq },
      });
    }

    return { stopped: aborted || cas.count > 0 };
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

  /**
   * 断言会话归属当前租户（复用 findOne 逻辑的精简版，不拉 messages）。
   * 文件接口不需要消息列表，只需确认会话存在且属于当前租户。
   */
  /** 返回会话归属的 userId：沙箱现按用户分配，文件接口需要它定位沙箱。 */
  private async assertConversationOwner(id: string, tenantId: string): Promise<string> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, tenantId },
      select: { id: true, userId: true },
    });
    if (!conv) {
      throw new BusinessException(
        ErrorCodes.CONVERSATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return conv.userId;
  }

  /**
   * 列出会话对应沙箱工作目录下的产物文件。
   *
   * 为什么用 find 而不是 ls：find 支持 -maxdepth 限制深度、-type f 只列文件、
   * -not -path 排除 node_modules 和隐藏目录，一条命令搞定，避免递归实现。
   * /skills/ 路径是 agent worker 注入的技能代码，不属于用户产物，排除之。
   */
  async listFiles(id: string, tenantId: string) {
    const ownerUserId = await this.assertConversationOwner(id, tenantId);

    const sb = await findUserSandbox(ownerUserId);
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const workdir = await sb.getWorkDir();
    // find 命令：从 workdir 出发，最多 4 层，只列普通文件，排除 node_modules / 隐藏路径 / skills 目录
    const cmd = `find "${workdir}" -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.*' -not -path '*/skills/*'`;
    const result = await sb.execute(cmd);

    const files = result.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // 转成相对于 workdir 的路径，去掉前导 /
      .map((abs) => ({
        path: abs.startsWith(workdir)
          ? abs.slice(workdir.length).replace(/^\//, '')
          : abs,
      }));

    return { files };
  }

  /**
   * 下载会话沙箱中的单个产物文件，以 base64 编码返回（前端解码）。
   *
   * 为什么走 base64 而非流式下载：本期不需要大文件传输，JSON envelope 统一格式
   * 更容易与前端现有的 fetch → JSON 解析链路对接；二进制流式下载留作后期迭代。
   *
   * 路由设计说明（见 controller）：文件下载放在独立的 /files/download 路由，
   * 而不是与列表合用 /files?path= 的查询参数分支，避免 controller 逻辑分叉。
   */
  async downloadFile(id: string, tenantId: string, relPath: string) {
    const ownerUserId = await this.assertConversationOwner(id, tenantId);

    // 路径安全断言：复用 skill-installer 的纯函数，避免重复实现
    // assertSafeEntryPath 对 '..' 片段和绝对路径抛出 SKILL_INSTALL_PATH_TRAVERSAL，
    // 这里转成语义更清晰的 INVALID_PATH
    try {
      assertSafeEntryPath(relPath);
    } catch {
      throw new BusinessException(
        ErrorCodes.INVALID_PATH,
        HttpStatus.BAD_REQUEST,
      );
    }

    const sb = await findUserSandbox(ownerUserId);
    if (!sb) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const workdir = await sb.getWorkDir();
    const absPath = join(workdir, relPath);
    const results = await sb.downloadFiles([absPath]);
    const file = results[0];

    if (!file || file.error || !file.content) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      path: relPath,
      contentBase64: Buffer.from(file.content).toString('base64'),
    };
  }
}
