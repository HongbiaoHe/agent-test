import { Command } from '@langchain/langgraph';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { buildAgent } from '../agent/agent.factory';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { normalize, RawEvent } from '../agent/event-normalizer';
import { CommandRegistryService } from '../commands/command-registry.service';
import { parseCommand } from '../commands/parse-command';
import { StreamService } from '../events/stream.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildSkillFiles } from './skill-files';

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
    private readonly commands: CommandRegistryService,
    @Inject(CHECKPOINTER) private readonly checkpointer: unknown,
    @InjectQueue('agent-run') private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { conversationId, kind, decisions } = job.data;

    if (kind === 'timeout') {
      await this.handleTimeout(conversationId);
      return;
    }

    const config = { configurable: { thread_id: conversationId } };

    try {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'running' },
      });

      // resume 续跑沿用 checkpointer 的中断态；run/追加则从 DB 重放完整对话历史，
      // 因为 deepagents 跑完一轮后不在持久化 state 保留对话消息（同 thread_id 续跑拿不到上文）。
      let runName = `审批续跑 · ${conversationId}`;
      let input: unknown;
      // 仅非 resume（新一轮重放）时按需注入既有任务计划，避免每轮重新拆解（详见 buildPlanPrompt）。
      let systemPromptExtra = '';
      if (kind === 'resume') {
        input = new Command({ resume: { decisions } });
      } else {
        const messages = await this.loadHistory(conversationId);
        // 把所有技能文件注入 per-thread state 的 /skills/ 下，供 deepagents SkillsMiddleware 发现/列出，
        // agent 据系统提示用 read_file 按需加载（原生 progressive disclosure）。files 随 thread_id 隔离。
        const files = buildSkillFiles(
          this.commands.all(),
          new Date().toISOString(),
        );
        // 历史按原样重放，不改写任何用户消息：/command 该触发哪个技能由 system prompt 约束
        // （见 agent.factory）。改写历史会让旧命令每轮被重新注入「先 read_file 读 SKILL.md」祈使，
        // 导致多轮里重复触发同一技能、重复读同一文件。这里只取末条 user 消息做 LangSmith runName。
        let lastLabel = '';
        for (const m of messages) {
          if (m.role !== 'user') continue;
          lastLabel = `Agent · ${m.content.slice(0, 60)}`;
          const cmd = parseCommand(m.content);
          if (!cmd) continue;
          const def = this.commands.get(cmd.name);
          if (!def) continue;
          lastLabel = `技能:${def.name} · ${cmd.args}`.slice(0, 60);
        }
        runName = lastLabel || runName;
        input = { messages, files };
        systemPromptExtra = await this.buildPlanPrompt(conversationId);
      }

      const agent = buildAgent({
        checkpointer: this.checkpointer,
        systemPromptExtra,
      });

      // runName/tags/metadata → LangSmith 里按此命名/过滤，而非只显示 "LangGraph"
      const stream = await agent.stream(input, {
        ...config,
        runName,
        tags: ['buzz-agent', kind ?? 'run'],
        metadata: { conversationId, kind: kind ?? 'run' },
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
      // 持久化 result：历史据此收尾未完成的工具卡、置为 done；实时丢失/重连也能从历史对齐。
      const resultEvt: RawEvent = { type: 'result', payload: { status: 'done' } };
      await this.stream.publish(conversationId, resultEvt);
      await this.persist(conversationId, resultEvt, seq++);
      this.logger.log(`agent 完成: conversation=${conversationId}`);
    } catch (e) {
      this.logger.error(`agent 失败: conversation=${conversationId} ${String(e)}`);
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'failed' },
      });
      const errorEvt: RawEvent = {
        type: 'error',
        payload: { message: e instanceof Error ? e.message : String(e) },
      };
      await this.stream.publish(conversationId, errorEvt);
      // catch 作用域取不到 try 内的 seq，重新计数后持久化
      const seq = await this.prisma.message.count({ where: { conversationId } });
      await this.persist(conversationId, errorEvt, seq);
    }
  }

  /**
   * 从 DB 重放该会话的完整对话历史（user/assistant 文本消息，按 seq）。
   * 工具调用/结果是每轮内的临时过程，不重放（也无法重建合法的 tool_call 配对）。
   */
  private async loadHistory(
    conversationId: string,
  ): Promise<{ role: string; content: string }[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        type: 'message',
        role: { in: ['user', 'assistant'] },
      },
      orderBy: { seq: 'asc' },
      select: { role: true, content: true },
    });
    return rows.map((m) => ({
      role: m.role,
      content: (m.content as { text?: string })?.text ?? '',
    }));
  }

  /**
   * 多轮重放时，模型在提示和消息里都看不到上一轮的任务计划：write_todos 产生的
   * plan_update / tool 消息不在 loadHistory 的重放范围内，langchain 的 todoListMiddleware
   * 也只注入「如何使用 write_todos」的说明、从不注入当前 todos 列表。叠加系统提示「收到目标后
   * 先 write_todos 拆解计划」，会导致每一轮都从零重新规划、计划不断变化。
   *
   * 这里取该会话最近一次计划注入系统提示，并要求按既定计划逐步执行、只更新状态，避免重新拆解。
   * 计划尚未产生（首轮）时返回空串，交由基础系统提示完成首次拆解。
   */
  private async buildPlanPrompt(conversationId: string): Promise<string> {
    const row = await this.prisma.message.findFirst({
      where: { conversationId, type: 'plan_update' },
      orderBy: { seq: 'desc' },
      select: { content: true },
    });
    const todos = (
      row?.content as { todos?: { content: string; status: string }[] } | null
    )?.todos;
    if (!Array.isArray(todos) || todos.length === 0) return '';

    const lines = todos
      .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
      .join('\n');
    return (
      `\n\n## 当前任务计划（已存在，请勿重新拆解）\n${lines}\n\n` +
      `本会话已有上面这份既定计划。请直接按它继续逐步执行：\n` +
      `- 不要重新拆解，不要新增、删除或改写步骤内容，保持步骤文本与顺序不变；\n` +
      `- 仅用 write_todos 更新每一步的状态（pending → in_progress → completed）；\n` +
      `- 开始某一步前标记为 in_progress，完成后立即标记为 completed。`
    );
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
