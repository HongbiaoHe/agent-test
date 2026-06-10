import type { BaseStore } from '@langchain/langgraph';
import { Command } from '@langchain/langgraph';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { buildAgent } from '../agent/agent.factory';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { getUserSandbox } from '../agent/sandbox';
import { normalize, RawEvent } from '../agent/event-normalizer';
import { parseCommand } from '../commands/parse-command';
import { StreamService } from '../events/stream.service';
import { MediaService } from '../media/media.service';
import { createMediaTools } from '../media/media.tools';
import { PrismaService } from '../prisma/prisma.service';
import { absolutizeRefPaths } from '../skills/skill-files';
import { seedSkillsStore } from '../skills/skill-store.seed';
import { SKILLS_STORE } from '../skills/skill-store.provider';
import type { SkillDef } from '../skills/skills.service';
import { SkillsService } from '../skills/skills.service';

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
    private readonly skills: SkillsService,
    @Inject(CHECKPOINTER) private readonly checkpointer: unknown,
    @InjectQueue('agent-run') private readonly queue: Queue,
    @Inject(SKILLS_STORE) private readonly store: BaseStore,
    private readonly media: MediaService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { conversationId, kind, decisions } = job.data;

    if (kind === 'timeout') {
      await this.handleTimeout(conversationId);
      return;
    }

    try {
      // update 返回整条记录，顺带取本会话选定的模型（前端可切换）传给 buildAgent
      const conv = await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { status: 'running' },
      });

      // config 在 conv 加载后定义，以便 getState 和 stream 均携带 userId
      // （StoreBackend namespace factory 在 state 读取时也可能被调用，保持一致）
      const config = {
        configurable: { thread_id: conversationId, userId: conv.userId },
      };

      // ① 播种：该用户生效技能 → InMemoryStore（diff 同步）
      // run/resume 共享：worker 重启后 InMemoryStore 为空，resume 不播种 → namespace 空、技能静默失效
      const defs = await this.skills.effectiveSkillsFor(conv.userId);
      await seedSkillsStore(this.store, conv.userId, defs);

      // ② 沙箱：user-scoped find-or-create（同一用户全部会话共享工作区）；无 key/创建失败 → 回退 StateBackend
      let sandbox: Awaited<ReturnType<typeof getUserSandbox>> = null;
      try {
        sandbox = await getUserSandbox(conv.userId);
      } catch (e) {
        // 降级而非失败整个 run；提示用户本轮无执行能力（设计 §8）
        await this.stream.publish(conversationId, {
          type: 'message',
          payload: { text: '⚠️ 沙箱创建失败，本轮无命令执行能力（文件与技能阅读不受影响）。' },
        } as RawEvent);
      }
      // sandbox 为 null 时不传 defaultBackend，buildAgent 内部 new StateBackend() 兜底（避免在 processor 引入 deepagents 直接依赖）
      const defaultBackend = sandbox ?? undefined;

      // resume 续跑沿用 checkpointer 的中断态；run/追加则从 DB 重放完整对话历史，
      // 因为 deepagents 跑完一轮后不在持久化 state 保留对话消息（同 thread_id 续跑拿不到上文）。
      let runName = `审批续跑 · ${conversationId}`;
      let input: unknown;
      let systemPromptExtra = '';
      if (kind === 'resume') {
        input = new Command({ resume: { decisions } });
      } else {
        const messages = await this.loadHistory(conversationId);
        // 历史按原样重放，不改写任何用户消息：/command 该触发哪个技能由 system prompt 约束
        // （见 agent.factory）。技能文件现在通过 InMemoryStore 播种（seedSkillsStore），
        // 不再全量注入 state.files——避免每轮刷新全部文件的写放大，且 store 已按 userId namespace 隔离。
        // 这里只取末条 user 消息做 LangSmith runName。
        let lastLabel = '';
        for (const m of messages) {
          if (m.role !== 'user') continue;
          lastLabel = `Agent · ${m.content.slice(0, 60)}`;
          const cmd = parseCommand(m.content);
          if (!cmd) continue;
          const def = await this.skills.getFor(conv.userId, cmd.name);
          if (!def) continue;
          lastLabel = `技能:${def.name} · ${cmd.args}`.slice(0, 60);
        }
        runName = lastLabel || runName;
        input = { messages };
        systemPromptExtra = await this.buildSkillPrompt(conv.userId, messages);
        const mediaInventory = await this.buildMediaInventory(conversationId, conv.userId);
        if (mediaInventory) {
          systemPromptExtra += mediaInventory;
        }
      }

      // 既有任务计划经 runtime context 注入：planContinuationMiddleware 会把它追加到系统提示
      // **末尾**（盖过 todoListMiddleware 的「随时重订」），根治多轮 todos 被整表替换、没执行完
      // 就换新列表。run/resume 都注入（resume 续跑同一轮，回注既有计划同样有益）。
      const activePlan = await this.buildActivePlan(conversationId);

      // ③ 装配：media 工具闭包注入——conversationId/userId 由 worker 上下文提供，不经模型传递（无注入风险）
      const extraTools = createMediaTools(this.media, {
        conversationId,
        userId: conv.userId,
      });
      const agent = buildAgent({
        checkpointer: this.checkpointer,
        systemPromptExtra,
        model: conv.model ?? undefined,
        defaultBackend,
        store: this.store,
        hasSandbox: !!sandbox,
        extraTools,
      });

      // ④ stream config：userId 同时进 configurable（StoreBackend namespace 用）与 context（中间件用）
      // runName/tags/metadata → LangSmith 里按此命名/过滤，而非只显示 "LangGraph"
      const stream = await agent.stream(input, {
        ...config,
        runName,
        tags: ['buzz-agent', kind ?? 'run'],
        metadata: { conversationId, kind: kind ?? 'run' },
        context: { activePlan, userId: conv.userId },
        streamMode: ['updates', 'messages'],
        subgraphs: true,
      } as never);

      // resume 续跑时从已有消息数接着排 seq
      let seq = await this.prisma.message.count({ where: { conversationId } });
      // 逐字 token 实时推流但不逐条落库（否则每条 token 一行、表爆炸）；改为按助手文本段累积，
      // 在遇到边界（工具调用/结果/计划/审批）或流结束时，把累积文本收口成一条完整 message：
      // 推流 + 落库都用「用户实际看到的累积文本」，从而 live 与刷新恢复一致、结尾不再被更短的聚合覆盖。
      let buf = '';
      const flush = async (override?: string) => {
        const text = override ?? buf;
        buf = '';
        if (!text) return;
        const msg: RawEvent = { type: 'message', payload: { text } };
        await this.stream.publish(conversationId, msg);
        await this.persist(conversationId, msg, seq++);
      };
      for await (const chunk of stream as AsyncIterable<unknown>) {
        const [ns, mode, data] = chunk as [string[], string, unknown];
        const raw = normalize(ns, mode, data);
        if (!raw) continue;
        if (raw.type === 'token') {
          buf += String((raw.payload as { text?: string }).text ?? '');
          await this.stream.publish(conversationId, raw);
          continue;
        }
        // updates 聚合出的 message 文本可能短于逐字流（如思考/工具叙述被裁剪）：优先用累积的 buf
        // 收口；buf 为空（非流式模型，未产生 token）时才退回 updates 文本，避免文本丢失。
        if (raw.type === 'message') {
          await flush(buf || String((raw.payload as { text?: string }).text ?? ''));
          continue;
        }
        // 其余非文本事件（tool_start/tool_end/plan_update/control_request）是文本段边界：
        // 先把已累积文本收口成 message，再推送并落库该事件。
        await flush();
        await this.stream.publish(conversationId, raw);
        await this.persist(conversationId, raw, seq++);
      }
      await flush(); // 流自然结束、末段文本无后继事件触发时收尾

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
   * 算出该会话「当前任务计划」文本，供 worker 经 runtime context 传给 planContinuationMiddleware
   * 注入系统提示末尾（见 agent.factory）。计划尚未产生（首轮）时返回空串，让模型自由完成首次拆解。
   *
   * 为什么需要它：多轮重放时模型在提示和消息里都看不到上一轮的任务计划——write_todos 产生的
   * plan_update / tool 消息不在 loadHistory 的重放范围内，langchain 的 todoListMiddleware 也只注入
   * 「如何使用 write_todos」的说明、从不注入当前 todos 列表，且其文案还鼓励「随时重订计划」。不回注
   * 既有计划，模型每轮都会整表重写 todos、把没执行完的步骤冲掉（用户观察到的「频繁换新 todos」）。
   *
   * 措辞刻意只锁「整表替换/删改重排」，仍允许末尾追加新发现的子任务，避免过度僵化。
   */
  private async buildActivePlan(conversationId: string): Promise<string> {
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
      `## 当前任务计划（已存在，继续执行，请勿重新拆解）\n${lines}\n\n` +
      `本会话已有上面这份既定计划，请在它的基础上继续：\n` +
      `- 保留已有步骤的文本与顺序不变，逐步用 write_todos 推进状态（pending → in_progress → completed）；\n` +
      `- 开始某一步前标记为 in_progress，完成后立即标记为 completed；\n` +
      `- 不要把整张列表替换成新的，也不要删除、改写或重排已有步骤；仅当确实发现新子任务时，可在末尾追加。`
    );
  }

  /**
   * 多轮续跑时，上一轮 read_file 读到的 SKILL.md 不会回到上下文里：loadHistory 只重放
   * user/assistant 文本消息，read_file 的调用与结果落在 tool_start/tool_end（见 ROLE_BY_TYPE）
   * 被排除，且 deepagents 跑完一轮不在 state 保留对话消息。于是每个后续轮次模型都缺少已激活
   * 技能的 SKILL.md，只能反复 read_file 同一个 /skills/<name>/SKILL.md（用户观察到的「重复读取」）。
   *
   * 这里：若本会话在**之前的轮次**已通过 /command 激活了某技能（即最近一次能解析到已知技能的
   * /command 不是本轮当前请求），就把该技能的 SKILL.md 全文注入系统提示，并显式告知无需再
   * read_file 读取它——从根上消除重复读取。引用文档/子技能仍按需 read_file（progressive disclosure）。
   * 本轮才首次发起的 /command 不注入，交由基础系统提示按 read_file 完成首次加载。
   * SKILL.md 经 absolutizeRefPaths 改写相对引用，保证注入后正文里的 references 路径仍能命中虚拟 FS。
   */
  private async buildSkillPrompt(
    userId: string,
    messages: { role: string; content: string }[],
  ): Promise<string> {
    const users = messages.filter((m) => m.role === 'user');
    if (users.length === 0) return '';
    const current = users[users.length - 1];

    let active: SkillDef | undefined;
    let activeMsg: { role: string; content: string } | undefined;
    for (const m of users) {
      const cmd = parseCommand(m.content);
      if (!cmd) continue;
      const def = await this.skills.getFor(userId, cmd.name);
      if (!def) continue;
      active = def;
      activeMsg = m;
    }
    // 没有激活任何技能，或激活就发生在本轮（首次加载，交给 read_file）→ 不注入
    if (!active || activeMsg === current) return '';

    const skillMd = active.files['SKILL.md'];
    if (!skillMd) return '';
    const content = absolutizeRefPaths(active.name, skillMd);
    return (
      `\n\n## 已加载技能：${active.name}（SKILL.md 已提供，请勿重复读取）\n` +
      `本会话在之前的轮次已通过 \`/${active.name}\` 激活该技能，其 SKILL.md 全文见下。` +
      `请直接据此继续，**不要再 read_file 读取 \`/skills/${active.name}/SKILL.md\`**；` +
      `仅当需要其引用的 references/ 子技能等子文件时，才按需 read_file 那些子文件。\n\n` +
      `<skill name="${active.name}">\n${content}\n</skill>`
    );
  }

  /**
   * 构建本会话已生成的媒体资产清单，注入系统提示让模型正确引用 versionId，避免编造。
   * 空会话（无生成位）返回空串，不注入。
   */
  private async buildMediaInventory(conversationId: string, userId: string): Promise<string> {
    const generations = await this.media.listForConversation(conversationId, userId);
    if (!generations || generations.length === 0) return '';

    const lines = generations
      .map((g) => {
        const v = g.versions[0]; // 最新版本（已按 createdAt desc）
        if (!v) return null;
        const promptPreview = v.prompt.slice(0, 40) + (v.prompt.length > 40 ? '…' : '');
        return `- versionId=${v.id} [${g.type}][${v.status}] ${promptPreview}`;
      })
      .filter(Boolean)
      .join('\n');
    if (!lines) return '';

    return (
      `\n\n## 本会话已生成的媒体资产（引用参考图必须用此表的 versionId）\n${lines}\n` +
      `规则：referenceVersionIds 只能填上表或 generate_image 工具结果中的真实 versionId（cuid 格式），禁止自造名称；表中已有的资产不要重复生成。`
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
