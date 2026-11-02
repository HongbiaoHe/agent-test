import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { BackgroundTask, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { findUserSandbox, keepUserSandboxAlive } from '../agent/sandbox';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { StreamService } from '../events/stream.service';
import { resultToModelText } from '../mcp/mcp-result';
import { McpAuthRequiredError, McpService } from '../mcp/mcp.service';
import { PrismaService } from '../prisma/prisma.service';
import { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import {
  type BackgroundKind,
  type BackgroundStatus,
  LIMITS,
  type TaskResult,
  truncate,
  type WatchSpec,
  wakeupSpecSchema,
  watchSpecSchema,
} from './background.types';
import { cancelScript, checkScript, parseCheck } from './sandbox-command';
import { evaluateWatch } from './watch-condition';

export const BG_QUEUE = 'bg-task';

/** 只有这几种会话状态可以被后台通知直接唤醒；运行中 / 等审批的等本轮结束再投递，停止了的不唤醒。 */
const WAKEABLE = ['idle', 'done', 'failed'];

export interface BackgroundTaskView {
  id: string;
  conversationId: string;
  kind: BackgroundKind;
  title: string;
  status: BackgroundStatus;
  result: TaskResult | null;
  polls: number;
  deadlineAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
}

/** 会话里一条后台通知（落成 role=user 的消息，content.notification 供前端识别成系统行）。 */
export interface TaskNotificationContent {
  text: string;
  notification: {
    taskId: string;
    kind: string;
    title: string;
    status: string;
  };
}

function minutes(n: number): number {
  return n * 60_000;
}

/** BackgroundTask.result 是我方写入的 TaskResult。 */
function resultOf(row: Pick<BackgroundTask, 'result'>): TaskResult | null {
  const r = row.result;
  return r && typeof r === 'object' && !Array.isArray(r) && 'text' in r
    ? (r as unknown as TaskResult)
    : null;
}

/** kind / status 列只由本服务写入，取值即 BackgroundKind / BackgroundStatus。 */
export function toView(row: BackgroundTask): BackgroundTaskView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind as BackgroundKind,
    title: row.title,
    status: row.status as BackgroundStatus,
    result: resultOf(row),
    polls: row.polls,
    deadlineAt: row.deadlineAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

/** 通知正文：给模型看，XML 包裹，明确是系统生成的而非用户发言（系统提示里有对应约定）。 */
export function notificationText(
  row: BackgroundTask,
  result: TaskResult,
): string {
  return [
    '<task-notification>',
    `<task-id>${row.id}</task-id>`,
    `<kind>${row.kind}</kind>`,
    `<status>${row.status}</status>`,
    `<title>${row.title}</title>`,
    `<result>\n${result.text}\n</result>`,
    '</task-notification>',
  ].join('\n');
}

/**
 * 会话后台任务：创建 / 推进（bg-task 队列逐次 tick）/ 结束 / 取消 / 结束后唤醒 agent。
 *
 * 设计目标：等异步结果（MCP 生成任务、沙箱长命令、过一会儿再看）时不再让模型反复调工具轮询——
 * 一次 BuzzVideo 生图实测单轮 9 次模型调用、20 万 token，几乎全花在 get_task + sleep 上。
 * 轮询全部在服务端跑，结束后以一条 <task-notification> 消息唤醒 agent（对齐 Claude Code 的 task-notification）。
 */
@Injectable()
export class BackgroundService {
  private readonly logger = new Logger(BackgroundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly mcp: McpService,
    private readonly sandboxSettings: SandboxSettingsService,
    @InjectQueue(BG_QUEUE) private readonly queue: Queue,
    @InjectQueue('agent-run') private readonly agentQueue: Queue,
  ) {}

  // ───────────────────────────── 创建 ─────────────────────────────

  /** 会话里还在跑的任务数达到上限时拒绝（返回给模型的错误文本由调用方组织）。 */
  async assertCapacity(conversationId: string): Promise<void> {
    const active = await this.prisma.backgroundTask.count({
      where: { conversationId, status: 'running' },
    });
    if (active >= LIMITS.maxActivePerConversation) {
      throw new Error(
        `This conversation already has ${active} background tasks running (max ${LIMITS.maxActivePerConversation}). Wait for one to finish or cancel one.`,
      );
    }
  }

  async create(input: {
    conversationId: string;
    userId: string;
    kind: BackgroundKind;
    title: string;
    spec: Prisma.InputJsonObject;
    timeoutMin: number;
    notify: boolean;
    /** 第一次 tick 的延迟 */
    firstTickMs: number;
  }): Promise<BackgroundTask> {
    const row = await this.prisma.backgroundTask.create({
      data: {
        conversationId: input.conversationId,
        userId: input.userId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        spec: input.spec,
        notify: input.notify,
        deadlineAt: new Date(Date.now() + minutes(input.timeoutMin)),
      },
    });
    await this.publish(row);
    await this.scheduleTick(row.id, 0, input.firstTickMs);
    return row;
  }

  // ───────────────────────────── 推进 ─────────────────────────────

  private async scheduleTick(taskId: string, polls: number, delayMs: number) {
    await this.queue.add(
      'tick',
      { taskId },
      {
        delay: Math.max(0, delayMs),
        // 同一次 tick 去重（重复投递 / 进程重启重放不会叠加）
        jobId: `${taskId}-${polls}`,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  /** bg-task 队列的一次推进。任务已结束（被取消等）直接忽略。 */
  async tick(taskId: string): Promise<void> {
    const row = await this.prisma.backgroundTask.findUnique({
      where: { id: taskId },
    });
    if (!row || row.status !== 'running') return;

    if (row.kind === 'wakeup') {
      const spec = wakeupSpecSchema.parse(row.spec);
      await this.finish(row, 'succeeded', {
        text: `Scheduled wakeup fired. Your note: ${spec.note}`,
      });
      return;
    }
    if (Date.now() >= row.deadlineAt.getTime()) {
      if (row.kind === 'command') await this.killCommand(row);
      await this.finish(row, 'timeout', {
        text: `Timed out after ${row.polls} checks without reaching the expected state.`,
      });
      return;
    }
    const polls = row.polls + 1;
    // 本次检查先计入：任务若在这次检查里结束，finish 写入的 polls 也要算上它
    const current = { ...row, polls };
    if (row.kind === 'watch') await this.tickWatch(current, polls);
    else if (row.kind === 'command') await this.tickCommand(current, polls);
  }

  private async tickWatch(row: BackgroundTask, polls: number) {
    const spec = watchSpecSchema.parse(row.spec);
    try {
      const result = await this.mcp.callTool(
        row.userId,
        spec.serverId,
        spec.toolName,
        spec.args,
      );
      const { outcome, value } = evaluateWatch(
        result,
        spec.untilPath,
        spec.doneValues,
        spec.failValues,
      );
      if (outcome !== 'pending') {
        await this.finish(row, outcome === 'done' ? 'succeeded' : 'failed', {
          text: truncate(resultToModelText(result)),
          value,
        });
        return;
      }
      await this.continueWith(row, polls, { ...spec, consecutiveErrors: 0 });
    } catch (e) {
      if (e instanceof McpAuthRequiredError) {
        await this.finish(row, 'failed', {
          text: `${e.serverName} needs to be reconnected; polling stopped.`,
        });
        return;
      }
      const errors = spec.consecutiveErrors + 1;
      this.logger.warn(
        `watch ${row.id} 第 ${polls} 次轮询失败（连续 ${errors}）：${String(e)}`,
      );
      if (errors >= LIMITS.maxConsecutiveErrors) {
        await this.finish(row, 'failed', {
          text: `Polling ${spec.modelToolName} failed ${errors} times in a row: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      await this.continueWith(row, polls, {
        ...spec,
        consecutiveErrors: errors,
      });
    }
  }

  private async continueWith(
    row: BackgroundTask,
    polls: number,
    spec: WatchSpec,
  ) {
    const updated = await this.prisma.backgroundTask.update({
      where: { id: row.id },
      data: { polls, spec },
    });
    await this.publish(updated);
    await this.scheduleTick(row.id, polls, spec.intervalSec * 1000);
  }

  private async tickCommand(row: BackgroundTask, polls: number) {
    const sandbox = await findUserSandbox(
      row.userId,
      await this.sandboxSettings.resolve(row.userId),
    );
    if (!sandbox) {
      await this.finish(row, 'failed', {
        text: 'The sandbox is no longer available; the background command was lost.',
      });
      return;
    }
    const out = await sandbox.execute(checkScript(row.id));
    const check = parseCheck(out.output);
    if (check.state === 'exited') {
      await this.finish(row, check.exitCode === 0 ? 'succeeded' : 'failed', {
        text: truncate(
          `Exit code ${check.exitCode}. Output tail (full log: .bg/${row.id}/out.log):\n${check.log}`,
        ),
        exitCode: check.exitCode,
      });
      return;
    }
    if (check.state === 'lost') {
      await this.finish(row, 'failed', {
        text: truncate(
          `The process is gone without an exit code (the sandbox may have been stopped). Output tail:\n${check.log}`,
        ),
      });
      return;
    }
    // 还在跑：替沙箱续命，别让闲置自动停机把后台进程一起暂停掉
    await keepUserSandboxAlive(
      row.userId,
      await this.sandboxSettings.resolve(row.userId),
    ).catch((e: unknown) => this.logger.warn(`沙箱续命失败：${String(e)}`));
    const updated = await this.prisma.backgroundTask.update({
      where: { id: row.id },
      data: { polls },
    });
    await this.publish(updated);
    await this.scheduleTick(
      row.id,
      polls,
      LIMITS.command.pollIntervalSec * 1000,
    );
  }

  // ───────────────────────────── 结束 / 取消 ─────────────────────────────

  /** CAS 结束：只有仍在 running 的任务能被结束，保证结束通知恰好一份。 */
  private async finish(
    row: BackgroundTask,
    status: Exclude<BackgroundStatus, 'running'>,
    result: TaskResult,
  ): Promise<void> {
    const cas = await this.prisma.backgroundTask.updateMany({
      where: { id: row.id, status: 'running' },
      data: {
        status,
        result: { ...result },
        polls: row.polls,
        finishedAt: new Date(),
        // 取消的任务不通知（是用户 / agent 主动停的）
        delivered: status === 'cancelled' || !row.notify,
      },
    });
    if (cas.count === 0) return;
    const updated = await this.prisma.backgroundTask.findUniqueOrThrow({
      where: { id: row.id },
    });
    await this.publish(updated);
    if (status !== 'cancelled' && row.notify) {
      await this.deliverPending(row.conversationId);
    }
  }

  async failUnexpected(taskId: string, error: unknown): Promise<void> {
    const row = await this.prisma.backgroundTask.findUnique({
      where: { id: taskId },
    });
    if (!row) return;
    await this.finish(row, 'failed', {
      text: `Background task crashed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  async cancel(userId: string, taskId: string): Promise<BackgroundTaskView> {
    const row = await this.prisma.backgroundTask.findFirst({
      where: { id: taskId, userId },
    });
    if (!row) {
      throw new BusinessException(
        ErrorCodes.BACKGROUND_TASK_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.status === 'running') {
      if (row.kind === 'command') await this.killCommand(row);
      await this.finish(row, 'cancelled', { text: 'Cancelled.' });
    }
    return toView(
      await this.prisma.backgroundTask.findUniqueOrThrow({
        where: { id: row.id },
      }),
    );
  }

  /** 用户停止会话：一并取消该会话所有在跑的后台任务（设计决策：停止 = 停止所有操作）。 */
  async cancelByConversation(conversationId: string): Promise<void> {
    const rows = await this.prisma.backgroundTask.findMany({
      where: { conversationId, status: 'running' },
    });
    for (const row of rows) {
      if (row.kind === 'command') await this.killCommand(row);
      await this.finish(row, 'cancelled', {
        text: 'Cancelled (conversation stopped).',
      });
    }
  }

  private async killCommand(row: BackgroundTask): Promise<void> {
    try {
      const sandbox = await findUserSandbox(
        row.userId,
        await this.sandboxSettings.resolve(row.userId),
      );
      await sandbox?.execute(cancelScript(row.id));
    } catch (e) {
      // 收尾失败无害：进程随沙箱闲置停机一并回收
      this.logger.warn(`终止后台命令 ${row.id} 失败：${String(e)}`);
    }
  }

  // ───────────────────────────── 通知投递 ─────────────────────────────

  /**
   * 把已结束、未投递的通知写进会话并唤醒 agent。
   * 会话正忙（running / waiting_approval / queued）时什么都不做——worker 在这一轮 done 后会再调一次。
   * CAS 把会话置成 queued 成功的那一方负责写消息与入队，并发调用也只会唤醒一次。
   */
  async deliverPending(conversationId: string): Promise<void> {
    const pending = await this.prisma.backgroundTask.findMany({
      where: {
        conversationId,
        delivered: false,
        notify: true,
        status: { not: 'running' },
      },
      orderBy: { finishedAt: 'asc' },
    });
    if (pending.length === 0) return;
    const cas = await this.prisma.conversation.updateMany({
      where: { id: conversationId, status: { in: WAKEABLE }, deletedAt: null },
      data: { status: 'queued' },
    });
    if (cas.count === 0) return;

    await this.prisma.backgroundTask.updateMany({
      where: { id: { in: pending.map((t) => t.id) }, delivered: false },
      data: { delivered: true },
    });
    let seq = await this.prisma.message.count({ where: { conversationId } });
    for (const row of pending) {
      const content: TaskNotificationContent = {
        text: notificationText(row, resultOf(row) ?? { text: '' }),
        notification: {
          taskId: row.id,
          kind: row.kind,
          title: row.title,
          status: row.status,
        },
      };
      await this.prisma.message.create({
        data: {
          conversationId,
          role: 'user',
          type: 'message',
          content: {
            text: content.text,
            notification: { ...content.notification },
          },
          seq: seq++,
        },
      });
      await this.stream.publish(conversationId, {
        type: 'task_notification',
        payload: content,
      });
    }
    await this.agentQueue.add('run', { conversationId });
    this.logger.log(
      `会话 ${conversationId} 投递 ${pending.length} 条后台任务通知并唤醒 agent`,
    );
  }

  async listByConversation(
    userId: string,
    conversationId: string,
  ): Promise<BackgroundTaskView[]> {
    const rows = await this.prisma.backgroundTask.findMany({
      where: { conversationId, userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  private async publish(row: BackgroundTask): Promise<void> {
    await this.stream.publish(row.conversationId, {
      type: 'bg_task_update',
      payload: toView(row),
    });
  }
}
