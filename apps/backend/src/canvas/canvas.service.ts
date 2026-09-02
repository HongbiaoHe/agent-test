import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { AbortRegistry } from '../agent/abort-registry';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { StreamService } from '../events/stream.service';
import { MediaService, readParams } from '../media/media.service';
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
  type CanvasTokenReport,
  type CanvasTokenRun,
  asApprovalMode,
  canConnectNodeTypes,
  collectGenerationInputs,
  collectVideoSources,
  isCanvasNodeType,
  joinPromptParts,
  shortNodeId,
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
    // eslint-disable-next-line no-fallthrough -- 三者产出形状一致，共用下面这一段
    case 'video_concat':
      return media?.status === 'done'
        ? [
            {
              // 出视频的有两种：生成与拼接。漏掉后者会让它对外声称自己产出图片，
              // 下游连线（video_gen 收 image 当首帧）与再一次拼接都会接错。
              type:
                type === 'video_gen' || type === 'video_concat'
                  ? 'video'
                  : 'image',
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
    thinkingLevel?: string,
    approvalMode?: string,
  ): Promise<{ sessionId: string }> {
    const baseData = {
      tenantId,
      userId,
      model,
      thinkingLevel,
      approvalMode,
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
  /**
   * 用户手动触发某个 video_concat 节点的拼接（卡片上的 Merge）。
   *
   * 与 agent 的 merge_video_node 是同一件事的两个入口：素材同样按入边顺序取
   * （collectVideoSources，与卡片预览顺序同源），同样落一个 MediaVersion 并回填
   * generationId，之后的状态流转/资产/下游引用与生成节点没有区别。
   */
  async mergeVideoNode(
    id: string,
    tenantId: string,
    userId: string,
    nodeId: string,
  ): Promise<{ generationId: string }> {
    await this.assertOwner(id, tenantId);
    const snap = await this.buildSnapshot(id);
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NODE_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (node.type !== 'video_concat') {
      throw new BusinessException(
        ErrorCodes.CANVAS_EDGE_INVALID,
        HttpStatus.BAD_REQUEST,
      );
    }
    const sources = collectVideoSources(snap.nodes, snap.edges, nodeId);
    // 少于两段没什么可拼的；media 层也会再拦一次（那是权威校验）
    if (sources.length < 2) {
      throw new BusinessException(
        ErrorCodes.MEDIA_REF_INVALID,
        HttpStatus.BAD_REQUEST,
      );
    }
    const { generationId } = await this.media.createConcat(id, userId, sources);
    await this.applyOp(id, 'user', {
      op: 'update_node',
      nodeId,
      mediaGenerationId: generationId,
    });
    return { generationId };
  }

  /**
   * 用户手动触发某个 image_gen / video_gen 节点的生成（卡片上的 Generate）。
   *
   * 与 agent 的 generate_media_node 是同一件事的两个入口：素材同样全部取自入边
   * （collectGenerationInputs），模型同样取节点上选定的那份（没选就回落默认模型），
   * 同样落一个新的 MediaGeneration 并回填 generationId——之后的状态流转/资产/下游引用一模一样。
   */
  async generateMediaNode(
    id: string,
    tenantId: string,
    userId: string,
    nodeId: string,
  ): Promise<{ generationId: string }> {
    await this.assertOwner(id, tenantId);
    const snap = await this.buildSnapshot(id);
    const node = snap.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new BusinessException(
        ErrorCodes.CANVAS_NODE_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    if (node.type !== 'image_gen' && node.type !== 'video_gen') {
      throw new BusinessException(
        ErrorCodes.CANVAS_EDGE_INVALID,
        HttpStatus.BAD_REQUEST,
      );
    }
    const inputs = collectGenerationInputs(snap.nodes, snap.edges, nodeId);
    if (inputs.promptParts.length === 0) {
      throw new BusinessException(
        ErrorCodes.CANVAS_PROMPT_REQUIRED,
        HttpStatus.BAD_REQUEST,
      );
    }
    const { generationId } = await this.media.createGeneration(
      id,
      userId,
      node.type === 'video_gen' ? 'video' : 'image',
      joinPromptParts(inputs.promptParts),
      inputs.referenceVersionIds.length
        ? inputs.referenceVersionIds
        : undefined,
      {
        channel: node.mediaChannel ?? undefined,
        model: node.mediaModel ?? undefined,
        params: node.mediaParams ?? undefined,
      },
    );
    await this.applyOp(id, 'user', {
      op: 'update_node',
      nodeId,
      mediaGenerationId: generationId,
    });
    return { generationId };
  }

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

    // 用户圈定了节点（「加入对话」）→ 本段只列这些节点。大画布上用户往往只想让 agent 动其中几张卡，
    // 全量列出既淹没重点、又每次变化都要重付一份长快照。
    const focus = new Set(snap.focusNodeIds);
    const listed =
      focus.size > 0 ? snap.nodes.filter((n) => focus.has(n.id)) : snap.nodes;
    // 连线取「至少一端被圈中」的：只列两端都在圈内的话，模型看不到这些节点的上游从哪来
    const listedEdges =
      focus.size > 0
        ? snap.edges.filter((e) => focus.has(e.source) || focus.has(e.target))
        : snap.edges;

    // id 一律用短 id（完整 cuid 的后 6 位）：完整 id 会让本段膨胀近 3 倍，而这段每次画布变化都要
    // 追加一份进上下文。工具侧用 resolveNodeId 反解，短 id / 完整 id 都吃。
    const nodeLines = listed.map((n) => {
      const desc = (n.label ?? n.text ?? n.prompt ?? '').slice(0, 30);
      const media = n.mediaStatus ? ` <生成:${n.mediaStatus}>` : '';
      return `- ${shortNodeId(n.id)} [${n.type}] "${desc}" @(${Math.round(n.x)},${Math.round(n.y)})${media}`;
    });
    const edgeLines = listedEdges.map(
      (e) => `- ${shortNodeId(e.source)} → ${shortNodeId(e.target)}`,
    );

    // 安全区始终按**全部**节点算：只按圈中的算会让新节点压在圈外的节点上
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

    const scope =
      focus.size > 0
        ? `\n\n### 关注范围\n用户已圈定 ${listed.length} 个节点加入本次对话，上面只列了这些节点` +
          `（画布上另有 ${snap.nodes.length - listed.length} 个节点未圈定，未列出）。\n` +
          `**请只对上面列出的节点动手**；确需改动其它节点时，先说明理由并请用户取消圈定。`
        : '';

    return (
      `## 当前画布实时状态（画布一有变化就自动追加最新一份，直接使用，无需调用任何工具查询画布）\n` +
      `节点（${listed.length}）：\n${nodeLines.join('\n') || '（无）'}\n\n` +
      `连线（${listedEdges.length}）：\n${edgeLines.join('\n') || '（无）'}\n\n` +
      `### 放置安全区（避免节点重叠）\n${safe}${scope}`
    );
  }

  /**
   * 设置 / 清空「加入对话」的节点圈选。
   *
   * 存在会话上而不是随单条消息传：这是一份**持续生效的关注范围**（像给对话别上几张卡），
   * 用户不主动取消就一直生效，注入中间件每次调用都按它裁剪。传空数组 = 恢复关注整块画布。
   * 传进来的 id 先与实际节点求交，避免存下已删除的节点。
   */
  async setFocus(id: string, tenantId: string, nodeIds: string[]) {
    await this.assertOwner(id, tenantId);
    const existing = await this.prisma.canvasNode.findMany({
      where: { sessionId: id, id: { in: nodeIds } },
      select: { id: true },
    });
    const valid = existing.map((n) => n.id);
    await this.prisma.canvasSession.update({
      where: { id },
      data: { focusNodeIds: valid },
    });
    return { focusNodeIds: valid };
  }

  /**
   * 把模型给的节点 id 解析成完整 id。注入给模型的是短 id（后 6 位，见 shortNodeId），
   * 但模型也可能回传 add_node 返回值里的完整 id —— 两种都要吃。
   * 完整 id 走精确匹配；否则按后缀匹配，匹配不到或有歧义返回 null，由调用方报错给模型。
   */
  async resolveNodeId(sessionId: string, id: string): Promise<string | null> {
    const nodes = await this.prisma.canvasNode.findMany({
      where: { sessionId },
      select: { id: true },
    });
    if (nodes.some((n) => n.id === id)) return id;
    const matched = nodes.filter((n) => n.id.endsWith(id));
    return matched.length === 1 ? matched[0].id : null;
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
      thinkingLevel: session.thinkingLevel,
      approvalMode: asApprovalMode(session.approvalMode),
      revision: session.revision,
      totalTokens: tokenAgg._sum.totalTokens ?? 0,
      // 圈定的节点里可能有已被删掉的，过滤掉再回给前端，免得画布上标不出来又清不掉
      focusNodeIds: readFocusIds(session.focusNodeIds).filter((fid) =>
        session.nodes.some((n) => n.id === fid),
      ),
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

  /**
   * 手动清空当前任务计划：追加一条空 plan_update（todos: []）作为「计划已作废」标记。
   *
   * 之后这份计划就不再影响 agent——buildActivePlan 见到空列表即不注入系统提示，
   * loadHistory 也会跳过该标记之前的 write_todos 工具消息（两处均在 canvas.processor）。
   * 用追加而非删除：历史消息是回放源，删掉会让已发生的对话出现空洞。
   */
  async clearPlan(id: string, tenantId: string): Promise<{ cleared: true }> {
    await this.assertOwner(id, tenantId);
    const seq = await this.prisma.canvasMessage.count({
      where: { sessionId: id },
    });
    await this.prisma.canvasMessage.create({
      data: {
        sessionId: id,
        role: 'assistant',
        type: 'plan_update',
        content: { todos: [] },
        seq,
      },
    });
    // 广播：多端/同页其他订阅者据此隐藏计划面板
    await this.stream.publish(id, {
      type: 'plan_update',
      payload: { todos: [] },
    });
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
    thinkingLevel?: string,
    approvalMode?: string,
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
      data: {
        status: 'queued',
        ...(model ? { model } : {}),
        // 显式传了才覆盖：不传保留会话既有档位
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(approvalMode ? { approvalMode } : {}),
      },
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
            ...(op.mediaChannel !== undefined
              ? { mediaChannel: op.mediaChannel }
              : {}),
            ...(op.mediaModel !== undefined
              ? { mediaModel: op.mediaModel }
              : {}),
            ...(op.mediaParams !== undefined
              ? { mediaParams: op.mediaParams }
              : {}),
            ...(op.x !== undefined ? { x: op.x } : {}),
            ...(op.y !== undefined ? { y: op.y } : {}),
            version: { increment: 1 },
          },
        });
        // 带上 media JOIN 状态：生成刚入队时（generate_media_node 回填 mediaGenerationId）
        // 这条 patch 是前端最早能拿到的信号，不带状态节点就一直显示「未生成」，
        // 直到 worker 真正开跑才变 —— 排队中的节点看起来像没被触发。
        const media = node.mediaGenerationId
          ? (await this.resolveMedia([node.mediaGenerationId])).get(
              node.mediaGenerationId,
            )
          : undefined;
        return {
          op: 'update_node',
          node: this.toNodeDto(node, media),
          revision,
        };
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
      mediaChannel: string | null;
      mediaModel: string | null;
      mediaParams: unknown;
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
      mediaChannel: n.mediaChannel,
      mediaModel: n.mediaModel,
      // Json 列读出来是 JsonValue，收窄成 Record<string,string>；没配过就是 null
      mediaParams: n.mediaParams === null ? null : readParams(n.mediaParams),
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

/**
 * Prisma 的 Json 列读出来是 JsonValue，收窄成 string[]（非数组 / 混类型一律当没圈定）。
 * 不用断言：外部数据的形状要在边界上用守卫收窄（CLAUDE.md §8）。
 */
function readFocusIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
