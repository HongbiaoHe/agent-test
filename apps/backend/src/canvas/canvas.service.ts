import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { AbortRegistry } from '../agent/abort-registry';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { CANVAS_ABORTS } from './canvas.abort';
import {
  type ApplyOpResult,
  type CanvasActor,
  type CanvasEdgeDto,
  type CanvasNodeDto,
  type CanvasNodeOutput,
  type CanvasNodeType,
  type CanvasOpInput,
  type CanvasPatch,
  type CanvasSnapshot,
  type CanvasTokenCall,
  type CanvasTokenModelUsage,
  type CanvasTokenReport,
  type CanvasTokenRun,
  type CanvasTokenTotals,
  canConnectNodeTypes,
  isCanvasNodeType,
} from './canvas.types';
import { groupByModel, sumCalls } from './token-usage';

/**
 * checkpointer 的最小可用面（清空会话只需删 thread）。
 * RedisSaver 实现了 deleteThread（@langchain/langgraph-checkpoint-redis dist/index.d.ts:26），
 * 这里按最小接口约束注入项，避免整个 service 依赖其全量类型。
 */
interface ThreadDeletableCheckpointer {
  deleteThread(threadId: string): Promise<void>;
}

/** 画布"忙"状态：此时用户结构编辑被服务端拒绝（运行期只读）。 */
const BUSY_STATUSES = ['queued', 'running', 'waiting_approval'];

/** 内部哨兵：revision CAS 落空（并发写），触发重试。 */
class RevisionRaceError extends Error {}

/** 取 CanvasRun.trigger 里的 goal 文本（形状为 { goal: string }，见 processor.ensureRun）。 */
function readTriggerGoal(trigger: Prisma.JsonValue): string {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    return '';
  }
  const goal = trigger.goal;
  return typeof goal === 'string' ? goal : '';
}

/**
 * 派生节点的对外输出（不落表，见 CanvasNodeDto.outputs）。
 * 统一包成数组便于以后一次产多份；当前每种节点最多一份，未就绪即空数组。
 */
function deriveOutputs(
  type: CanvasNodeType,
  n: { text: string | null; assetPath: string | null },
  media?: { id: string; status: string },
): CanvasNodeOutput[] {
  switch (type) {
    case 'text':
      return n.text?.trim() ? [{ type: 'text', content: n.text }] : [];
    // MVP 模拟上传：没有 MediaVersion，content 破例存 assetPath
    case 'image_upload':
      return n.assetPath ? [{ type: 'image', content: n.assetPath }] : [];
    case 'image_gen':
    case 'video_gen':
      return media?.status === 'done'
        ? [
            {
              type: type === 'video_gen' ? 'video' : 'image',
              content: media.id,
            },
          ]
        : [];
  }
}

/**
 * 画布业务层：会话管理 + 唯一结构写入口 applyOp（事务：物化表 + CanvasOp 日志 + revision）。
 * 服务端单一真相源；所有变更提交后经 StreamService 广播 canvas_patch（stream id = sessionId）。
 * 与现有 ConversationsService 同构但完全独立（独立表 / 独立队列 canvas-run / 独立 abort）。
 */
@Injectable()
export class CanvasService {
  private readonly logger = new Logger(CanvasService.name);
  /** 每个 sessionId 一条 applyOp 串行队列（promise 链），避免同会话并发结构写竞争。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    @InjectQueue('canvas-run') private readonly queue: Queue,
    private readonly media: MediaService,
    @Inject(CANVAS_ABORTS) private readonly aborts: AbortRegistry,
    // 只用到 deleteThread（清空 agent 上下文）；按最小接口注入，避免依赖 RedisSaver 全量类型
    @Inject(CHECKPOINTER)
    private readonly checkpointer: ThreadDeletableCheckpointer,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // 会话管理（镜像 ConversationsService 的建/列/停/追加）
  // ───────────────────────────────────────────────────────────────────────────

  /** 建画布：无 goal → idle 空画布；有 goal → queued + 落首条 user 消息 + 入队跑 agent。 */
  async create(
    goal: string | undefined,
    title: string | undefined,
    tenantId: string,
    userId: string,
    model?: string,
  ): Promise<{ sessionId: string }> {
    const baseData = {
      tenantId,
      userId,
      model,
      ...(title?.trim() ? { title } : {}),
    };
    if (!goal?.trim()) {
      const s = await this.prisma.canvasSession.create({
        data: { ...baseData, status: 'idle' },
      });
      return { sessionId: s.id };
    }
    const s = await this.prisma.canvasSession.create({
      data: { ...baseData, status: 'queued' },
    });
    await this.prisma.canvasMessage.create({
      data: {
        sessionId: s.id,
        role: 'user',
        type: 'message',
        content: { text: goal },
        seq: 0,
      },
    });
    await this.queue.add('run', { sessionId: s.id, goal });
    return { sessionId: s.id };
  }

  /**
   * 列出当前租户的画布（cursor 分页，前端滚动加载）。
   * 多取一探测下一页：满页时 nextCursor = 本页末项 id，前端带它取下一页
   * （cursor+skip:1 跳过锚点自身）；orderBy 带 id 兜底保证同 updatedAt 时序稳定。
   */
  async list(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{
    items: { id: string; title: string; status: string; updatedAt: Date }[];
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.prisma.canvasSession.findMany({
      where: { tenantId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, title: true, status: true, updatedAt: true },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor: rows.length > limit ? items[items.length - 1].id : null,
    };
  }

  /** 重命名画布（仅改标题）。空白标题拒绝；归属经 assertOwner 校验。 */
  async rename(id: string, title: string, tenantId: string) {
    await this.assertOwner(id, tenantId);
    const trimmed = title.trim();
    if (!trimmed) {
      throw new BusinessException(ErrorCodes.CANVAS_TITLE_EMPTY);
    }
    return this.prisma.canvasSession.update({
      where: { id },
      data: { title: trimmed },
      select: { id: true, title: true },
    });
  }

  /** 画布完整快照（REST）：先校验租户归属，再构建。 */
  async snapshot(id: string, tenantId: string): Promise<CanvasSnapshot> {
    await this.assertOwner(id, tenantId);
    return this.buildSnapshot(id);
  }

  /**
   * 给 agent 工具用的快照（免租户校验）：sessionId 来自可信 worker 上下文（不经模型），无越权风险。
   */
  async agentSnapshot(sessionId: string): Promise<CanvasSnapshot> {
    return this.buildSnapshot(sessionId);
  }

  /**
   * 每轮注入模型提示词的「实时画布状态 + 放置安全区」文本（替代 agent 反复调用 get_canvas）。
   * 安全区 = 现有全部节点的**右侧或下方**：把新节点放进去即不与现有节点重叠。
   * 节点尺寸按卡片实际大小取保守值（W×H），留 GAP 间距。
   */
  async agentCanvasContext(sessionId: string): Promise<string> {
    const snap = await this.buildSnapshot(sessionId);
    const W = 280;
    // 媒体型卡片改成「封面满宽置顶」后变高（128px 封面 + 标题/提示词约 60px），H 跟着抬到 220
    const H = 220;
    const GAP = 40;

    const nodeLines = snap.nodes.map((n) => {
      const desc = (n.label ?? n.text ?? n.prompt ?? '').slice(0, 30);
      const media = n.mediaStatus ? ` <生成:${n.mediaStatus}>` : '';
      return `- ${n.id} [${n.type}] "${desc}" @(${Math.round(n.x)},${Math.round(n.y)})${media}`;
    });
    const edgeLines = snap.edges.map((e) => `- ${e.source} → ${e.target}`);

    let safe: string;
    if (snap.nodes.length === 0) {
      safe = `画布为空。从 (40, 40) 开始布局：向右每列 +${W + GAP}px、向下每行 +${H + GAP}px。`;
    } else {
      const rightX =
        Math.round(Math.max(...snap.nodes.map((n) => n.x + W))) + GAP;
      const belowY =
        Math.round(Math.max(...snap.nodes.map((n) => n.y + H))) + GAP;
      const topY = Math.round(Math.min(...snap.nodes.map((n) => n.y)));
      const leftX = Math.round(Math.min(...snap.nodes.map((n) => n.x)));
      safe =
        `现有节点占据区域：x∈[${leftX}, ${rightX - GAP}]、y∈[${topY}, ${belowY - GAP}]。\n` +
        `**新增节点必须放到安全区**（否则会与现有节点重叠）：右侧 x ≥ ${rightX}，或下方 y ≥ ${belowY}。\n` +
        `同批多个新节点之间：横向间隔 ≥ ${W + GAP}px、纵向间隔 ≥ ${H + GAP}px。` +
        `建议：接着现有节点向右新开一列，从 (${rightX}, ${topY}) 起向下依次排列。`;
    }

    return (
      `## 当前画布实时状态（每轮自动注入，直接使用，无需调用任何工具查询画布）\n` +
      `节点（${snap.nodes.length}）：\n${nodeLines.join('\n') || '（无）'}\n\n` +
      `连线（${snap.edges.length}）：\n${edgeLines.join('\n') || '（无）'}\n\n` +
      `### 放置安全区（避免节点重叠）\n${safe}`
    );
  }

  /** 构建快照：session + 节点 + 边；生成节点按 mediaGenerationId JOIN 最新 MediaVersion。 */
  private async buildSnapshot(id: string): Promise<CanvasSnapshot> {
    const session = await this.prisma.canvasSession.findUnique({
      where: { id },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        edges: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!session) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }

    const latestByGen = await this.resolveMedia(
      session.nodes
        .map((n) => n.mediaGenerationId)
        .filter((g): g is string => !!g),
    );

    // 会话累计 token：run 级持久化列的聚合（明细在 CanvasTokenUsage，快照只回总量）
    const tokenAgg = await this.prisma.canvasRun.aggregate({
      where: { sessionId: id },
      _sum: { totalTokens: true },
    });

    return {
      id: session.id,
      title: session.title,
      status: session.status,
      model: session.model,
      revision: session.revision,
      totalTokens: tokenAgg._sum.totalTokens ?? 0,
      nodes: session.nodes.map((n) =>
        this.toNodeDto(n, latestByGen.get(n.mediaGenerationId ?? '')),
      ),
      edges: session.edges.map((e) => this.toEdgeDto(e)),
    };
  }

  /**
   * 清空会话记录与 agent 上下文（DELETE /canvas/:id/messages）。
   *
   * 清什么：CanvasMessage（对话历史，也是 worker loadHistory 的重放源）+ checkpointer 里
   * 该 thread 的 LangGraph 状态（中断/续跑上下文）。清完 agent 下一轮从零上下文起跑。
   * 不清什么：节点/连线（用户的画布成果）、CanvasRun / CanvasTokenUsage（token 消耗审计，
   * 花掉的 token 是真花了，会话框仍显示历史累计）。
   * 运行期拒绝（CANVAS_BUSY）：正在跑的 run 还会继续写消息，清空会留下半截历史。
   */
  async clearMessages(
    id: string,
    tenantId: string,
  ): Promise<{ cleared: true }> {
    const session = await this.prisma.canvasSession.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!session) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!['idle', 'done', 'failed', 'stopped'].includes(session.status)) {
      throw new BusinessException(ErrorCodes.CANVAS_BUSY);
    }

    await this.prisma.canvasMessage.deleteMany({ where: { sessionId: id } });
    // agent 上下文：RedisSaver.deleteThread（thread_id = sessionId，见 canvas.processor）。
    // 失败只告警——DB 历史已清即达成"无上下文"主目标（checkpointer 残留会被下轮覆盖）。
    try {
      await this.checkpointer.deleteThread(id);
    } catch (e) {
      this.logger.warn(
        `清空 checkpointer thread 失败 session=${id}: ${String(e)}`,
      );
    }
    await this.prisma.canvasSession.update({
      where: { id },
      data: { status: 'idle' },
    });
    // 广播：多端/同页其他订阅者据此清空本地对话投影
    await this.stream.publish(id, { type: 'messages_cleared', payload: {} });
    return { cleared: true };
  }

  /** 画布 agent 对话消息（历史回放源，按 seq）。 */
  async findMessages(id: string, tenantId: string) {
    await this.assertOwner(id, tenantId);
    return this.prisma.canvasMessage.findMany({
      where: { sessionId: id },
      orderBy: { seq: 'asc' },
    });
  }

  /**
   * token 用量报表（GET /canvas/:id/token-usage）：会话总计 + 按模型 + 按轮（含每次调用明细）。
   *
   * 数据源是 CanvasTokenUsage 明细行（每次模型调用一行），run 元信息（状态/目标/起止）来自
   * CanvasRun。三层合计都由同一批明细行现算，口径必然自洽（不依赖 run 上的累加列）。
   * 缓存命中率交给前端算（cacheRead / input），后端只给原始量。
   */
  async tokenReport(id: string, tenantId: string): Promise<CanvasTokenReport> {
    await this.assertOwner(id, tenantId);
    const [runs, rows] = await Promise.all([
      this.prisma.canvasRun.findMany({
        where: { sessionId: id },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          model: true,
          status: true,
          trigger: true,
          startedAt: true,
          endedAt: true,
        },
      }),
      this.prisma.canvasTokenUsage.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const calls: CanvasTokenCall[] = rows.map((r) => ({
      id: r.id,
      model: r.model,
      input: r.inputTokens,
      output: r.outputTokens,
      total: r.totalTokens,
      cacheRead: r.cacheReadTokens,
      cacheCreation: r.cacheCreationTokens,
      at: r.createdAt.toISOString(),
    }));
    const callsByRun = new Map<string, CanvasTokenCall[]>();
    rows.forEach((r, i) => {
      const list = callsByRun.get(r.runId);
      if (list) list.push(calls[i]);
      else callsByRun.set(r.runId, [calls[i]]);
    });

    return {
      totals: sumCalls(calls),
      byModel: groupByModel(calls),
      runs: runs.map((run): CanvasTokenRun => {
        const runCalls = callsByRun.get(run.id) ?? [];
        return {
          runId: run.id,
          requestedModel: run.model,
          status: run.status,
          goal: readTriggerGoal(run.trigger),
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt?.toISOString() ?? null,
          totals: sumCalls(runCalls),
          byModel: groupByModel(runCalls),
          calls: runCalls,
        };
      }),
    };
  }

  /** 追加用户消息并续跑（多轮，同 thread_id）。仅空闲态允许，否则 CANVAS_BUSY。 */
  async appendMessage(
    id: string,
    content: string,
    tenantId: string,
    userId: string,
    model?: string,
  ): Promise<{ sessionId: string }> {
    if (!content?.trim()) {
      throw new BusinessException(ErrorCodes.CANVAS_GOAL_EMPTY);
    }
    const session = await this.prisma.canvasSession.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!session) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!['idle', 'done', 'failed', 'stopped'].includes(session.status)) {
      throw new BusinessException(ErrorCodes.CANVAS_BUSY);
    }

    await this.prisma.canvasSession.update({
      where: { id },
      data: { status: 'queued', ...(model ? { model } : {}) },
    });
    const seq = await this.prisma.canvasMessage.count({
      where: { sessionId: id },
    });
    await this.prisma.canvasMessage.create({
      data: {
        sessionId: id,
        role: 'user',
        type: 'message',
        content: { text: content },
        seq,
      },
    });
    await this.queue.add('run', { sessionId: id, goal: content });
    return { sessionId: id };
  }

  /**
   * 主动停止当前运行（镜像 ConversationsService.stop 的竞态规则）：
   * abort() 返回 true ⇒ worker 收尾 result；false 且 CAS 命中 ⇒ 这里补发。
   */
  async stop(id: string, tenantId: string): Promise<{ stopped: boolean }> {
    await this.assertOwner(id, tenantId);
    const aborted = this.aborts.abort(id);
    // 会话级取消画布触发的媒体生成（media 以 sessionId 作 conversationId 记账）
    await this.media.cancelByConversation(id);

    const cas = await this.prisma.canvasSession.updateMany({
      where: { id, status: { in: BUSY_STATUSES } },
      data: { status: 'stopped' },
    });

    if (!aborted && cas.count > 0) {
      const seq = await this.prisma.canvasMessage.count({
        where: { sessionId: id },
      });
      const payload = { status: 'stopped' };
      await this.stream.publish(id, { type: 'result', payload });
      await this.prisma.canvasMessage.create({
        data: {
          sessionId: id,
          role: 'assistant',
          type: 'result',
          content: payload,
          seq,
        },
      });
    }
    return { stopped: aborted || cas.count > 0 };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 唯一结构写入口
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 应用一次结构变更（agent 工具与用户 REST 编辑的唯一入口）。
   * - 运行期（session busy）拒绝 actor=user 的结构变更（CANVAS_BUSY）；agent 不受限（它就是运行者）。
   * - 用户带 baseRevision：与当前 revision 不符 → CANVAS_CONFLICT（客户端已过期）。
   * - 事务内：改物化表 + node.version++（改 data 时）+ 追加 CanvasOp(seq) + revision CAS 自增。
   * - CAS 落空（并发 agent 工具）→ 有界重试。提交后广播 canvas_patch。
   */
  async applyOp(
    sessionId: string,
    actor: CanvasActor,
    op: CanvasOpInput,
    baseRevision?: number,
  ): Promise<ApplyOpResult> {
    // 同会话进程内串行化：agent 一个回合可能并发触发多个结构工具（LangGraph 并行执行
    // tool_calls），并发写会撞 revision/CanvasOp 唯一键。单 worker 下串行即根除竞争；
    // 跨 worker 仍靠事务内 revision CAS + 唯一键 + 重试兜底。
    const result = await this.serialize(sessionId, () =>
      this.applyOpWithRetry(sessionId, actor, op, baseRevision),
    );
    await this.stream.publish(sessionId, {
      type: 'canvas_patch',
      payload: result.patch,
    });
    return result;
  }

  private async applyOpWithRetry(
    sessionId: string,
    actor: CanvasActor,
    op: CanvasOpInput,
    baseRevision?: number,
  ): Promise<ApplyOpResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.applyOpOnce(sessionId, actor, op, baseRevision);
      } catch (e) {
        // revision CAS 落空 或 CanvasOp 唯一键冲突（P2002）= 并发写竞争 → 重试
        const racy =
          e instanceof RevisionRaceError ||
          (e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === 'P2002');
        if (racy && attempt < 4) {
          this.logger.warn(`applyOp 竞争重试 session=${sessionId}`);
          continue;
        }
        throw e;
      }
    }
    throw new RevisionRaceError();
  }

  /** 按 key（sessionId）串行执行：把任务挂到该 key 的 promise 链尾，天然一个接一个跑。 */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // 链尾吞掉结果与异常，仅用于排队；下一个任务无论前一个成败都接着跑
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async applyOpOnce(
    sessionId: string,
    actor: CanvasActor,
    op: CanvasOpInput,
    baseRevision?: number,
  ): Promise<ApplyOpResult> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.canvasSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, revision: true },
      });
      if (!session) {
        throw new BusinessException(
          ErrorCodes.CANVAS_NOT_FOUND,
          HttpStatus.NOT_FOUND,
        );
      }
      // 运行期只读：agent 是唯一写者，用户结构变更被拒
      if (actor === 'user' && BUSY_STATUSES.includes(session.status)) {
        throw new BusinessException(ErrorCodes.CANVAS_BUSY);
      }
      // 乐观并发：用户带 baseRevision 且落后 → 冲突
      if (
        actor === 'user' &&
        baseRevision !== undefined &&
        baseRevision !== session.revision
      ) {
        throw new BusinessException(
          ErrorCodes.CANVAS_CONFLICT,
          HttpStatus.CONFLICT,
        );
      }

      const nextRevision = session.revision + 1;

      // revision CAS 先行（串行化点）：where 带旧 revision，并发写里只有一个能命中；
      // 落空说明被抢先 → 抛竞争哨兵，在写物化表/op 之前就回滚重试（避免 CanvasOp 唯一键冲突）。
      const bumped = await tx.canvasSession.updateMany({
        where: { id: sessionId, revision: session.revision },
        data: { revision: nextRevision },
      });
      if (bumped.count === 0) throw new RevisionRaceError();

      const patch = await this.applyOpToTables(tx, sessionId, op, nextRevision);
      // 追加 op 日志（unique(sessionId,seq) 兜底跨进程并发）
      await tx.canvasOp.create({
        data: {
          sessionId,
          seq: nextRevision,
          actor,
          op: op as unknown as Prisma.InputJsonValue,
        },
      });

      return { revision: nextRevision, patch };
    });
  }

  /** 在事务内把 op 落到物化表并返回对应 patch。 */
  private async applyOpToTables(
    tx: Prisma.TransactionClient,
    sessionId: string,
    op: CanvasOpInput,
    revision: number,
  ): Promise<CanvasPatch> {
    switch (op.op) {
      case 'add_node': {
        const node = await tx.canvasNode.create({
          data: {
            sessionId,
            type: op.type,
            x: op.x ?? 0,
            y: op.y ?? 0,
            label: op.label ?? null,
            text: op.text ?? null,
            prompt: op.prompt ?? null,
            assetPath: op.assetPath ?? null,
          },
        });
        return { op: 'add_node', node: this.toNodeDto(node), revision };
      }
      case 'update_node': {
        const existing = await tx.canvasNode.findFirst({
          where: { id: op.nodeId, sessionId },
        });
        if (!existing) {
          throw new BusinessException(
            ErrorCodes.CANVAS_NODE_NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }
        const node = await tx.canvasNode.update({
          where: { id: op.nodeId },
          data: {
            ...(op.label !== undefined ? { label: op.label } : {}),
            ...(op.text !== undefined ? { text: op.text } : {}),
            ...(op.prompt !== undefined ? { prompt: op.prompt } : {}),
            ...(op.assetPath !== undefined ? { assetPath: op.assetPath } : {}),
            ...(op.mediaGenerationId !== undefined
              ? { mediaGenerationId: op.mediaGenerationId }
              : {}),
            ...(op.x !== undefined ? { x: op.x } : {}),
            ...(op.y !== undefined ? { y: op.y } : {}),
            version: { increment: 1 },
          },
        });
        return { op: 'update_node', node: this.toNodeDto(node), revision };
      }
      case 'remove_node': {
        const existing = await tx.canvasNode.findFirst({
          where: { id: op.nodeId, sessionId },
          select: { id: true },
        });
        if (!existing) {
          throw new BusinessException(
            ErrorCodes.CANVAS_NODE_NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }
        // 级联删相关边（source 或 target 命中）
        await tx.canvasEdge.deleteMany({
          where: {
            sessionId,
            OR: [{ source: op.nodeId }, { target: op.nodeId }],
          },
        });
        await tx.canvasNode.delete({ where: { id: op.nodeId } });
        return { op: 'remove_node', nodeId: op.nodeId, revision };
      }
      case 'add_edge': {
        // 类型契约校验（CANVAS_NODE_IO）：target 不接受 source 的输出类型即拒绝，
        // 用户拖线与 agent connect_nodes 走同一条路径，前端拦不住的这里也拦。
        // 只作用于新增，历史遗留的非法边不动。
        const ends = await tx.canvasNode.findMany({
          where: { sessionId, id: { in: [op.source, op.target] } },
          select: { id: true, type: true },
        });
        const src = ends.find((n) => n.id === op.source);
        const dst = ends.find((n) => n.id === op.target);
        if (!src || !dst) {
          throw new BusinessException(
            ErrorCodes.CANVAS_NODE_NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }
        if (
          !isCanvasNodeType(src.type) ||
          !isCanvasNodeType(dst.type) ||
          !canConnectNodeTypes(src.type, dst.type)
        ) {
          throw new BusinessException(
            ErrorCodes.CANVAS_EDGE_INVALID,
            HttpStatus.BAD_REQUEST,
          );
        }
        // 幂等：同 (sessionId,source,target) 已存在则复用（unique 约束）
        const edge = await tx.canvasEdge.upsert({
          where: {
            sessionId_source_target: {
              sessionId,
              source: op.source,
              target: op.target,
            },
          },
          create: { sessionId, source: op.source, target: op.target },
          update: {},
        });
        return { op: 'add_edge', edge: this.toEdgeDto(edge), revision };
      }
      case 'remove_edge': {
        await tx.canvasEdge.deleteMany({
          where: { id: op.edgeId, sessionId },
        });
        return { op: 'remove_edge', edgeId: op.edgeId, revision };
      }
      case 'clear': {
        // 一次清空：删全部连线 + 全部节点（先边后点，虽无 FK 约束，语义清晰）
        await tx.canvasEdge.deleteMany({ where: { sessionId } });
        await tx.canvasNode.deleteMany({ where: { sessionId } });
        return { op: 'clear', revision };
      }
    }
  }

  /**
   * 节点位置更新：LWW，不占 revision、不进 op 日志、不 409。
   * 运行期也允许（位置是 presentation，不与 agent 结构写冲突）——但前端运行期禁拖以简化体验。
   */
  async moveNode(
    sessionId: string,
    nodeId: string,
    x: number,
    y: number,
    tenantId: string,
  ): Promise<void> {
    await this.assertOwner(sessionId, tenantId);
    const updated = await this.prisma.canvasNode.updateMany({
      where: { id: nodeId, sessionId },
      data: { x, y },
    });
    if (updated.count === 0) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NODE_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.stream.publish(sessionId, {
      type: 'canvas_patch',
      payload: { op: 'move_node', nodeId, x, y },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** 断言画布归属当前租户，返回 session 摘要。 */
  private async assertOwner(id: string, tenantId: string) {
    const s = await this.prisma.canvasSession.findFirst({
      where: { id, tenantId },
      select: { id: true, userId: true, status: true, revision: true },
    });
    if (!s) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return s;
  }

  /** 批量解析生成节点的最新 MediaVersion（generationId → {id,status}）。 */
  private async resolveMedia(
    generationIds: string[],
  ): Promise<Map<string, { id: string; status: string }>> {
    const map = new Map<string, { id: string; status: string }>();
    if (generationIds.length === 0) return map;
    const versions = await this.prisma.mediaVersion.findMany({
      where: { generationId: { in: generationIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, generationId: true, status: true },
    });
    for (const v of versions) {
      if (!map.has(v.generationId)) {
        map.set(v.generationId, { id: v.id, status: v.status });
      }
    }
    return map;
  }

  private toNodeDto(
    n: {
      id: string;
      type: string;
      x: number;
      y: number;
      version: number;
      label: string | null;
      text: string | null;
      prompt: string | null;
      assetPath: string | null;
      mediaGenerationId: string | null;
    },
    media?: { id: string; status: string },
  ): CanvasNodeDto {
    const type: CanvasNodeType = isCanvasNodeType(n.type) ? n.type : 'text';
    return {
      id: n.id,
      type,
      x: n.x,
      y: n.y,
      version: n.version,
      label: n.label,
      text: n.text,
      prompt: n.prompt,
      assetPath: n.assetPath,
      mediaGenerationId: n.mediaGenerationId,
      mediaVersionId: media?.id ?? null,
      mediaStatus: media?.status ?? null,
      outputs: deriveOutputs(type, n, media),
    };
  }

  private toEdgeDto(e: {
    id: string;
    source: string;
    target: string;
  }): CanvasEdgeDto {
    return { id: e.id, source: e.source, target: e.target };
  }
}
