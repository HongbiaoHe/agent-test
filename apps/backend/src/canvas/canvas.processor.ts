import { isAIMessage, isBaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AbortRegistry } from '../agent/abort-registry';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { normalize, RawEvent } from '../agent/event-normalizer';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { CANVAS_ABORTS } from './canvas.abort';
import {
  buildCanvasAgent,
  resolveCanvasModelName,
} from './canvas.agent.factory';
import { CanvasService } from './canvas.service';
import { createCanvasTools } from './canvas.tools';
import { type CallUsage, extractUsages } from './token-usage';

interface JobData {
  sessionId: string;
  goal?: string;
  kind?: 'run' | 'resume' | 'timeout';
  decisions?: unknown[];
}

const TIMEOUT_MS = Number(process.env.CANVAS_APPROVAL_TIMEOUT_MS ?? 600000);

const ROLE_BY_TYPE: Record<string, string> = {
  message: 'assistant',
  result: 'assistant',
  plan_update: 'assistant',
  tool_start: 'assistant',
  tool_end: 'tool',
  control_request: 'assistant',
  error: 'assistant',
};

/**
 * 画布 harness agent worker（独立队列 canvas-run）。镜像 AgentProcessor 的状态机与流式落库，
 * 但用画布独立表 + CanvasRun 会计 + token 落库 + ask_user 中断回路。可长跑（>1h）。
 *
 * 长跑配置：lockDuration 拉到 5min（BullMQ 在 job 活跃期间自动续锁，避免小时级 job 被误判
 * stalled 重复消费）；concurrency=5 让多个画布会话并行（否则长任务会互相阻塞）。
 */
@Processor('canvas-run', { concurrency: 5, lockDuration: 300000 })
export class CanvasProcessor extends WorkerHost {
  private readonly logger = new Logger(CanvasProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly canvas: CanvasService,
    private readonly media: MediaService,
    @Inject(CHECKPOINTER) private readonly checkpointer: unknown,
    @InjectQueue('canvas-run') private readonly queue: Queue,
    @Inject(CANVAS_ABORTS) private readonly aborts: AbortRegistry,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { sessionId, kind, decisions } = job.data;

    if (kind === 'timeout') {
      await this.handleTimeout(sessionId);
      return;
    }

    const { signal, dispose } = this.aborts.register(sessionId);
    let buf = '';
    let runId = '';
    try {
      // CAS 门：排队期间被 stop 的 job 不起跑
      const gate = await this.prisma.canvasSession.updateMany({
        where: { id: sessionId, status: { not: 'stopped' } },
        data: { status: 'running' },
      });
      if (gate.count === 0) {
        if (signal.aborted) await this.finalizeStopped(sessionId, '');
        return;
      }
      const session = await this.prisma.canvasSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      // token 明细里模型名的回落值：必须与 factory 真正装配的模型同一口径
      // （旧代码回落到 GOOGLE_GENAI_MODEL，会把画布默认模型错标成主 agent 的模型）
      const modelName = resolveCanvasModelName(session.model);

      // Run 会计：run → 新建；resume → 复用最近未决 run
      runId = await this.ensureRun(
        sessionId,
        kind ?? 'run',
        job.data.goal,
        session.model,
      );

      const config = {
        configurable: { thread_id: sessionId, userId: session.userId },
      };

      let input: unknown;
      if (kind === 'resume') {
        input = new Command({ resume: { decisions } });
      } else {
        const messages = await this.loadHistory(sessionId);
        input = { messages };
      }
      // 把「当前任务计划」经 context 注入系统提示（run 与 resume 都注入，跨轮/续跑都能看到既有计划、
      // 逐步推进不重订）。buildActivePlan 内已跳过「全部完成」的计划（做完的不再回注，见其实现）。
      const activePlan = await this.buildActivePlan(sessionId);

      const tools = createCanvasTools(this.canvas, this.media, {
        sessionId,
        userId: session.userId,
      });
      const agent = await buildCanvasAgent({
        checkpointer: this.checkpointer,
        model: session.model ?? undefined,
        tools,
        // 每轮把最新画布状态 + 安全区注入提示词（省去 get_canvas 调用、保证实时性）
        liveCanvasContext: (sid) => this.canvas.agentCanvasContext(sid),
      });

      const stream = await agent.stream(input, {
        ...config,
        signal,
        runName: `Canvas · ${sessionId}`,
        tags: ['canvas', kind ?? 'run'],
        metadata: { sessionId, kind: kind ?? 'run' },
        context: { activePlan, userId: session.userId, sessionId },
        streamMode: ['updates', 'messages'],
        subgraphs: true,
        // 一次运行的 LangGraph 超步上限。agent 每个回合（模型节点 + 工具节点 + 各中间件 hook）要吃掉
        // 好几个超步，50 只够约 10 次工具调用——实测连 5 步计划都会撞「Recursion limit reached」失败。
        // 设 500 给长 harness 充足余量；真正的失控防护交给 modelCallLimit/toolCallLimit 中间件（触顶优雅结束）。
        recursionLimit: 500,
      });

      let seq = await this.prisma.canvasMessage.count({
        where: { sessionId },
      });
      // 会话级累计起点 = 历史全部 run 的持久化总量：token_usage 事件的 cumulativeTotal
      // 因此是**会话级**口径（与快照 totalTokens 一致），前端直显、刷新/多轮不归零。
      const prevAgg = await this.prisma.canvasRun.aggregate({
        where: { sessionId },
        _sum: { totalTokens: true },
      });
      let cumulativeTotal = prevAgg._sum.totalTokens ?? 0;
      const seenUsageIds = new Set<string>();
      // tool_start echo 去重：updates 会跨节点回显同一带 tool_calls 的 AIMessage（同 id），
      // 不去重会导致一次工具调用显示成多张卡片（用户观察到的"添加节点 ×3"）。
      const seenToolStartIds = new Set<string>();

      // 去重：deepagents 的 updates 流会在同一轮把同一个 AIMessage 跨多个节点回显多次，
      // 每次都会触发 flush → 同一段助手文本被重复 publish+persist（实测一段被落 4 次）。
      // 记录上一段已刷文本，相同则跳过。
      let lastFlushed = '';
      const flush = async (override?: string) => {
        const text = override ?? buf;
        buf = '';
        if (!text || text === lastFlushed) return;
        lastFlushed = text;
        const msg: RawEvent = { type: 'message', payload: { text } };
        await this.stream.publish(sessionId, msg);
        await this.persist(sessionId, runId, msg, seq++);
      };

      for await (const chunk of stream) {
        const [ns, mode, data] = chunk as [string[], string, unknown];

        // token 落库：updates 模式的完整 AIMessage 带 usage_metadata（按 message id 去重）
        if (mode === 'updates') {
          for (const usage of extractUsages(data, seenUsageIds, modelName)) {
            cumulativeTotal += usage.total;
            await this.recordUsage(sessionId, runId, usage, cumulativeTotal);
          }
        }

        const raw = normalize(ns, mode, data);
        if (!raw) continue;
        if (raw.type === 'token') {
          buf += String((raw.payload as { text?: string }).text ?? '');
          await this.stream.publish(sessionId, raw);
          continue;
        }
        if (raw.type === 'message') {
          await flush(
            buf || String((raw.payload as { text?: string }).text ?? ''),
          );
          continue;
        }
        // tool_start echo 去重：同一带 tool_calls 的 AIMessage 被 updates 跨节点回显（同 id），
        // 只在首次出现时记一条；工具真实只执行一次（实测 6 节点 vs 33 次 tool_call 事件）。
        if (raw.type === 'tool_start' && mode === 'updates') {
          const id = toolCallMsgId(data);
          if (id) {
            if (seenToolStartIds.has(id)) continue;
            seenToolStartIds.add(id);
          }
        }
        await flush();
        // 边界事件后重置去重基准：dedup 只针对"同一段被 updates 重复回显"，
        // 隔着工具调用的两条合法相同消息不应被误去重。
        lastFlushed = '';
        await this.stream.publish(sessionId, raw);
        await this.persist(sessionId, runId, raw, seq++);
      }
      await flush();

      // 审批中断（ask_user）：暂停等用户回答
      const state = (await agent.getState(config)) as {
        tasks?: { interrupts?: { value?: unknown }[] }[];
      };
      const interrupts = (state?.tasks ?? []).flatMap(
        (t) => t.interrupts ?? [],
      );
      if (interrupts.length > 0) {
        const value = interrupts[0]?.value;
        const toApproval = await this.prisma.canvasSession.updateMany({
          where: { id: sessionId, status: 'running' },
          data: { status: 'waiting_approval' },
        });
        if (toApproval.count === 0) {
          await this.finalizeStopped(sessionId, '');
          return;
        }
        await this.prisma.canvasRun.update({
          where: { id: runId },
          data: { status: 'waiting_approval' },
        });
        const evt: RawEvent = { type: 'control_request', payload: value };
        await this.stream.publish(sessionId, evt);
        await this.persist(sessionId, runId, evt, seq++);
        await this.queue.add(
          'timeout',
          { sessionId, kind: 'timeout' },
          { delay: TIMEOUT_MS },
        );
        return;
      }

      // 正常完成
      const toDone = await this.prisma.canvasSession.updateMany({
        where: { id: sessionId, status: 'running' },
        data: { status: 'done' },
      });
      if (toDone.count === 0) {
        await this.finalizeStopped(sessionId, '');
        return;
      }
      await this.finalizeRun(runId, 'done');
      const resultEvt: RawEvent = {
        type: 'result',
        payload: { status: 'done' },
      };
      await this.stream.publish(sessionId, resultEvt);
      await this.persist(sessionId, runId, resultEvt, seq++);
      this.logger.log(`canvas 完成: session=${sessionId}`);
    } catch (e) {
      if (signal.aborted) {
        this.logger.log(`canvas 停止: session=${sessionId}`);
        if (runId) await this.finalizeRun(runId, 'stopped');
        await this.finalizeStopped(sessionId, buf);
        return;
      }
      this.logger.error(`canvas 失败: session=${sessionId} ${String(e)}`);
      await this.prisma.canvasSession.update({
        where: { id: sessionId },
        data: { status: 'failed' },
      });
      if (runId) {
        await this.finalizeRun(
          runId,
          'failed',
          e instanceof Error ? e.message : String(e),
        );
      }
      const errorEvt: RawEvent = {
        type: 'error',
        payload: { message: e instanceof Error ? e.message : String(e) },
      };
      await this.stream.publish(sessionId, errorEvt);
      const seq = await this.prisma.canvasMessage.count({
        where: { sessionId },
      });
      await this.persist(sessionId, runId, errorEvt, seq);
    } finally {
      dispose();
    }
  }

  /** run → 新建 CanvasRun；resume → 复用最近未决 run（无则建）。返回 runId。 */
  private async ensureRun(
    sessionId: string,
    kind: 'run' | 'resume',
    goal: string | undefined,
    model: string | null,
  ): Promise<string> {
    if (kind === 'resume') {
      const existing = await this.prisma.canvasRun.findFirst({
        where: { sessionId, status: { in: ['waiting_approval', 'running'] } },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.canvasRun.update({
          where: { id: existing.id },
          data: { status: 'running' },
        });
        return existing.id;
      }
    }
    const run = await this.prisma.canvasRun.create({
      data: {
        sessionId,
        status: 'running',
        trigger: { goal: goal ?? '' },
        model,
      },
    });
    return run.id;
  }

  private async finalizeRun(runId: string, status: string, error?: string) {
    await this.prisma.canvasRun.update({
      where: { id: runId },
      data: { status, endedAt: new Date(), ...(error ? { error } : {}) },
    });
  }

  /** 记一次 token 用量（含缓存明细）：明细行 + Run 累加 + 推流。 */
  private async recordUsage(
    sessionId: string,
    runId: string,
    usage: CallUsage,
    cumulativeTotal: number,
  ) {
    await this.prisma.canvasTokenUsage.create({
      data: {
        sessionId,
        runId,
        model: usage.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        totalTokens: usage.total,
        cacheReadTokens: usage.cacheRead,
        cacheCreationTokens: usage.cacheCreation,
      },
    });
    await this.prisma.canvasRun.update({
      where: { id: runId },
      data: {
        promptTokens: { increment: usage.input },
        completionTokens: { increment: usage.output },
        totalTokens: { increment: usage.total },
        cacheReadTokens: { increment: usage.cacheRead },
        cacheCreationTokens: { increment: usage.cacheCreation },
      },
    });
    await this.stream.publish(sessionId, {
      type: 'token_usage',
      payload: {
        runId,
        model: usage.model,
        input: usage.input,
        output: usage.output,
        total: usage.total,
        cacheRead: usage.cacheRead,
        cacheCreation: usage.cacheCreation,
        cumulativeTotal,
      },
    });
  }

  private async finalizeStopped(sessionId: string, leftover: string) {
    let seq = await this.prisma.canvasMessage.count({ where: { sessionId } });
    if (leftover) {
      const msg: RawEvent = { type: 'message', payload: { text: leftover } };
      await this.stream.publish(sessionId, msg);
      await this.persist(sessionId, '', msg, seq++);
    }
    const evt: RawEvent = { type: 'result', payload: { status: 'stopped' } };
    await this.stream.publish(sessionId, evt);
    await this.persist(sessionId, '', evt, seq);
  }

  private async loadHistory(
    sessionId: string,
  ): Promise<{ role: string; content: string; tool_call_id?: string }[]> {
    const MAX_MSGS = 200;
    const rows = await this.prisma.canvasMessage.findMany({
      where: {
        sessionId,
        type: { in: ['message', 'tool_end'] },
        role: { in: ['user', 'assistant', 'tool'] },
      },
      orderBy: { seq: 'asc' },
      select: { role: true, content: true, type: true, seq: true },
    });

    let slice = rows.length > MAX_MSGS ? rows.slice(-MAX_MSGS) : rows;
    while (slice.length > 0 && slice[0].role !== 'user') {
      slice = slice.slice(1);
    }

    return slice.map((m) => {
      if (m.type === 'tool_end') {
        const payload = m.content as { name?: string; content?: unknown };
        const text =
          typeof payload.content === 'string'
            ? payload.content
            : JSON.stringify(payload.content);
        return {
          role: 'tool',
          content: text,
          tool_call_id: `synth_${payload.name ?? 'tool'}_${m.seq}`,
        };
      }
      return {
        role: m.role,
        content: (m.content as { text?: string })?.text ?? '',
      };
    });
  }

  private async buildActivePlan(sessionId: string): Promise<string> {
    const row = await this.prisma.canvasMessage.findFirst({
      where: { sessionId, type: 'plan_update' },
      orderBy: { seq: 'desc' },
      select: { content: true },
    });
    const todos = (
      row?.content as { todos?: { content: string; status: string }[] } | null
    )?.todos;
    if (!Array.isArray(todos) || todos.length === 0) return '';
    // 上一轮计划已全部完成 → 不注入（否则会让下一条新命令误以为"继续这份已完成计划、勿重新拆解"，
    // 影响新任务规划）。新命令由 write_todos 从头拆解自己的计划。
    if (todos.every((t) => t.status === 'completed')) return '';

    const lines = todos
      .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
      .join('\n');
    return (
      `## 当前任务计划（已存在，继续执行，请勿重新拆解）\n${lines}\n\n` +
      `请在既有计划基础上继续：保留已有步骤文本与顺序，用 write_todos 逐步推进状态；` +
      `不要整表替换或删改已有步骤，仅在确有新子任务时于末尾追加。`
    );
  }

  private async handleTimeout(sessionId: string): Promise<void> {
    const cas = await this.prisma.canvasSession.updateMany({
      where: { id: sessionId, status: 'waiting_approval' },
      data: { status: 'running' },
    });
    if (cas.count === 0) return;

    this.logger.warn(`canvas=${sessionId} 提问超时，自动以空回答继续`);
    await this.stream.publish(sessionId, {
      type: 'message',
      payload: { text: '⏱ 用户长时间未回答，按默认继续。' },
    });
    await this.queue.add('resume', {
      sessionId,
      kind: 'resume',
      // reject.message 会回传给模型（langchain HITL 无 respond）；语义=跳过提问、按最佳判断继续
      decisions: [
        { type: 'reject', message: '用户未回答，请按你的最佳判断继续。' },
      ],
    });
  }

  private async persist(
    sessionId: string,
    runId: string,
    raw: RawEvent,
    seq: number,
  ) {
    await this.prisma.canvasMessage.create({
      data: {
        sessionId,
        runId: runId || null,
        role: ROLE_BY_TYPE[raw.type] ?? 'assistant',
        type: raw.type,
        content: raw.payload as object,
        seq,
      },
    });
  }
}

/**
 * 取 updates 更新里"带 tool_calls 的 AIMessage"的 id（用于 tool_start echo 去重）。
 * 与 normalizeUpdate 定位 tool_start 的逻辑一致：末条 AIMessage 且有 tool_calls。无则 null。
 */
function toolCallMsgId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const msgs = (value as { messages?: unknown[] }).messages;
    if (!Array.isArray(msgs) || msgs.length === 0) continue;
    const last = msgs[msgs.length - 1];
    if (
      isBaseMessage(last) &&
      isAIMessage(last) &&
      last.tool_calls &&
      last.tool_calls.length > 0
    ) {
      return last.id ?? null;
    }
  }
  return null;
}
