import { Command } from '@langchain/langgraph';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { buildAgent } from '../agent/agent.factory';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { normalize, RawEvent } from '../agent/event-normalizer';
import { StreamService } from '../events/stream.service';
import { PrismaService } from '../prisma/prisma.service';

interface JobData {
  conversationId: string;
  goal?: string;
  kind?: 'run' | 'resume' | 'timeout';
  decisions?: unknown[];
}

const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000);

const ROLE_BY_TYPE: Record<string, string> = {
  message: 'assistant',
  result: 'assistant',
  plan_update: 'assistant',
  tool_start: 'assistant',
  tool_end: 'tool',
  control_request: 'assistant',
  error: 'assistant',
};

@Processor('agent-run')
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    @Inject(CHECKPOINTER) private readonly checkpointer: unknown,
    @InjectQueue('agent-run') private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { conversationId, goal, kind, decisions } = job.data;

    if (kind === 'timeout') {
      await this.handleTimeout(conversationId);
      return;
    }

    const config = { configurable: { thread_id: conversationId } };
    const agent = buildAgent({ checkpointer: this.checkpointer });

    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'running' },
      });

      const input =
        kind === 'resume'
          ? new Command({ resume: { decisions } })
          : { messages: [{ role: 'user', content: goal }] };

      const stream = await agent.stream(input, {
        ...config,
        streamMode: ['updates', 'messages'],
        subgraphs: true,
      } as never);

      // resume 续跑时从已有消息数接着排 seq
      let seq = await this.prisma.message.count({ where: { conversationId } });
      for await (const chunk of stream as AsyncIterable<unknown>) {
        const [ns, mode, data] = chunk as [string[], string, unknown];
        const raw = normalize(ns, mode, data);
        if (!raw) continue;
        await this.stream.publish(conversationId, raw);
        if (raw.type !== 'token') await this.persist(conversationId, raw, seq++);
      }

      // 流结束后检测审批中断（state.tasks 是 LangGraph 内部概念，勿与业务表混淆）
      const state = (await agent.getState(config)) as {
        tasks?: { interrupts?: { value?: unknown }[] }[];
      };
      const interrupts = (state?.tasks ?? []).flatMap((t) => t.interrupts ?? []);
      if (interrupts.length > 0) {
        const value = interrupts[0]?.value;
        this.logger.log(`conversation=${conversationId} 命中审批中断，等待用户决策`);
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { status: 'waiting_approval' },
        });
        const evt: RawEvent = { type: 'control_request', payload: value };
        await this.stream.publish(conversationId, evt);
        await this.persist(conversationId, evt, seq++);
        await this.queue.add(
          'timeout',
          { conversationId, kind: 'timeout' },
          { delay: TIMEOUT_MS },
        );
        return; // job 结束，释放 worker slot
      }

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'done' },
      });
      await this.stream.publish(conversationId, {
        type: 'result',
        payload: { status: 'done' },
      });
      this.logger.log(`agent 完成: conversation=${conversationId}`);
    } catch (e) {
      this.logger.error(`agent 失败: conversation=${conversationId} ${String(e)}`);
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'failed' },
      });
      await this.stream.publish(conversationId, {
        type: 'error',
        payload: { message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  /** 超时兜底：CAS 抢占成功则按默认 reject 续跑（用户已决策则 CAS 失败、忽略）。 */
  private async handleTimeout(conversationId: string): Promise<void> {
    const cas = await this.prisma.conversation.updateMany({
      where: { id: conversationId, status: 'waiting_approval' },
      data: { status: 'running' },
    });
    if (cas.count === 0) return; // 用户已决策，无需超时处理

    this.logger.warn(`conversation=${conversationId} 审批超时，自动拒绝`);
    await this.prisma.approval.create({
      data: {
        conversationId,
        decision: 'timeout',
        payload: { reason: 'approval_timeout' },
      },
    });
    await this.stream.publish(conversationId, {
      type: 'message',
      payload: { text: '⏱ 审批超时，已自动拒绝该操作。' },
    });
    await this.queue.add('resume', {
      conversationId,
      kind: 'resume',
      decisions: [{ type: 'reject' }],
    });
  }

  private async persist(conversationId: string, raw: RawEvent, seq: number) {
    await this.prisma.message.create({
      data: {
        conversationId,
        role: ROLE_BY_TYPE[raw.type] ?? 'assistant',
        type: raw.type,
        content: raw.payload as object,
        seq,
      },
    });
  }
}
