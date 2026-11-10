import { Prisma } from '@prisma/client';
import { Command } from '@langchain/langgraph';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { activePlanProvider } from '@agent-test/agent-core/modes/dynamic-context';
import type { DynamicContextProvider } from '@agent-test/agent-core/modes/dynamic-context';
import {
  instantiateTools,
  resolveMode,
} from '@agent-test/agent-core/modes/resolve-mode';
import type { ToolRegistry } from '@agent-test/agent-core/modes/tool-registry';
import {
  priorMessageIds,
  readInterrupt,
} from '@agent-test/agent-core/run/agent-state';
import { consumeAgentStream } from '@agent-test/agent-core/run/consume-stream';
import {
  historyFromRows,
  type HistoryMessage,
  roleOf,
} from '@agent-test/agent-core/run/history';
import {
  buildActivePlan,
  buildSkillPrompt,
} from '@agent-test/agent-core/run/turn-prompts';
import { mountSkills } from '@agent-test/agent-core/skills/skills-mount';
import { AbortRegistry, AGENT_ABORTS } from '../agent/abort-registry';
import { buildAgent } from '../agent/agent.factory';
import { CHECKPOINTER } from '../agent/checkpointer.provider';
import { getUserSandbox } from '../agent/sandbox';
import {
  type BackendHost,
  backendEnvironment,
  backendEnvPromptBlock,
  TOOL_REGISTRY,
} from '../agent/tool-registry.provider';
import { SandboxSettingsService } from '../sandbox/sandbox-settings.service';
import { RawEvent } from '../agent/event-normalizer';
import { resolveModelName } from '../agent/models';
import type { CallUsage } from '../agent/token-usage';
import { asThinkingLevel } from '../agent/thinking-level';
import { parseCommand } from '../commands/parse-command';
import { StreamService } from '../events/stream.service';
import { userMessageText } from '../conversations/message-content';
import { MediaService } from '../media/media.service';
import { UPLOAD_MODEL } from '../media/media-upload.service';
import { BackgroundService } from '../background/background.service';
import { appContextOf } from '../mcp/mcp-app-context';
import { buildMcpPrompt } from '../mcp/mcp-agent-tools';
import { McpService } from '../mcp/mcp.service';
import { toAgentMode } from '../modes/mode-view';
import { ModesService } from '../modes/modes.service';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';

interface JobData {
  conversationId: string;
  goal?: string;
  kind?: 'run' | 'resume' | 'timeout';
  decisions?: unknown[];
  /** timeout job 专用：中断的工具名，超时行为按此分叉（ask_user 自动采纳建议 vs 默认拒绝） */
  toolName?: string;
}

const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000);
/**
 * 轮内沙箱心跳间隔：须明显短于最小闲置时长（1 分钟），否则模型思考 / 长命令期间沙箱会在
 * 轮内暂停（E2B 超时是绝对时长，只在文件/命令操作前续期）。轮结束即停，之后按闲置时长正常暂停。
 */
const SANDBOX_HEARTBEAT_MS = 30_000;
/** ask_user 的服务端兜底超时：前端 60s 倒计时是主路径，这里只兜「页面已关」，须给足思考时间 */
const ASK_USER_TIMEOUT_MS = Number(process.env.ASK_USER_TIMEOUT_MS ?? 600000);

/** 一轮运行的 token 会计状态（见 prepareUsage）。 */
interface UsageContext {
  turnMessageId: string;
  seen: Set<string>;
  /** 会话累计（含本轮已记的） */
  total: number;
}

@Processor('agent-run')
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly skills: SkillsService,
    @Inject(CHECKPOINTER) private readonly checkpointer: unknown,
    @InjectQueue('agent-run') private readonly queue: Queue,
    private readonly media: MediaService,
    @Inject(AGENT_ABORTS) private readonly aborts: AbortRegistry,
    private readonly sandboxSettings: SandboxSettingsService,
    private readonly mcp: McpService,
    private readonly background: BackgroundService,
    @Inject(TOOL_REGISTRY)
    private readonly registry: ToolRegistry<BackendHost>,
    private readonly modes: ModesService,
  ) {
    super();
  }

  async process(job: Job<JobData>): Promise<void> {
    const { conversationId, kind, decisions } = job.data;

    if (kind === 'timeout') {
      await this.handleTimeout(conversationId, job.data.toolName);
      return;
    }

    // 注册可中止句柄——必须在 timeout 早退之后：timeout job 与 resume run 可共存，
    // 在早退前注册会覆盖正在跑的 resume 的注册（停止设计 §worker 接入顺序）。
    const { signal, dispose } = this.aborts.register(conversationId);
    // 轮内沙箱心跳，finally 统一清掉（正常结束 / 失败 / 停止都不能漏）
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      // CAS 门：排队期间被 stop 端点置为 stopped 的 job 不起跑。
      // 竞态规则：端点 abort() 返回 true ⇒ 由 worker 发 result（此处或流中 catch）；
      // false ⇒ 端点已按 CAS 补发，这里静默退出（设计 §竞态规则）。
      const gate = await this.prisma.conversation.updateMany({
        where: { id: conversationId, status: { not: 'stopped' } },
        data: { status: 'running' },
      });
      if (gate.count === 0) {
        if (signal.aborted) await this.finalizeStopped(conversationId);
        return;
      }
      // CAS（updateMany）不返回记录，补一次读取拿本会话的 userId / 选定模型
      const conv = await this.prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });

      // config 在 conv 加载后定义，以便 getState 和 stream 均携带 userId
      // （StoreBackend namespace factory 在 state 读取时也可能被调用，保持一致）
      const config = {
        configurable: { thread_id: conversationId, userId: conv.userId },
      };

      // ① 取该用户生效技能（含全部文件内容）：按模式过滤后挂载，多轮 SKILL.md 注入也复用
      const defs = await this.skills.effectiveSkillsFor(conv.userId);

      // ② 沙箱：user-scoped find-or-create（同一用户全部会话共享工作区）；无 key/创建失败 → 回退内存 backend
      let sandbox: Awaited<ReturnType<typeof getUserSandbox>> = null;
      try {
        // 用户在 /settings/profile 选的提供方（未选/未配置 → env 默认）
        sandbox = await getUserSandbox(
          conv.userId,
          await this.sandboxSettings.resolve(conv.userId),
        );
      } catch (e) {
        // 降级而非失败整个 run；提示用户本轮无执行能力（设计 §8）
        this.logger.warn(
          `getUserSandbox 失败，降级 StateBackend：${(e as Error)?.message ?? e}`,
        );
        // 出站策略被提供方拒绝（账户等级不支持）是配置问题而不是故障：给出可操作的提示
        const networkUnsupported =
          e instanceof Error && e.name === 'SandboxNetworkUnsupportedError';
        await this.stream.publish(conversationId, {
          type: 'message',
          payload: {
            text: networkUnsupported
              ? '⚠️ 当前沙箱账户不支持按沙箱限制出站网络，本轮未使用沙箱（无命令执行与技能能力）。请在 Settings → Sandbox 把出站改为「Open internet」，或切换到 E2B。'
              : '⚠️ 沙箱创建失败，本轮无命令执行与技能能力。',
          },
        });
      }

      if (sandbox) {
        const sb = sandbox;
        heartbeat = setInterval(() => {
          // 续期失败只记日志：沙箱可能已被外部暂停 / 删除，下一次工具调用会把错误带给模型
          sb.heartbeat().catch((e: unknown) => {
            this.logger.warn(
              `沙箱心跳失败 conversation=${conversationId}: ${String(e)}`,
            );
          });
        }, SANDBOX_HEARTBEAT_MS);
      }

      // ③ 按模式装配（纯函数）：模式是会话上的 modeId（被删 → 回通用模式）；运行环境按沙箱有无描述，
      // 不满足 capability 的工具降级跳过并写进系统提示。MCP 按工具快照装配（不连 server），
      // run 与 resume 都要装：审批通过后的续跑得能执行被批准的 MCP 工具。
      // 通用模式读该用户的提示词覆盖（没有行 / 为 NULL → resolveMode 用 GENERAL_MODE_PROMPT）。
      // 平台片段的用户改写对通用模式与普通模式都生效（没改写的用 core 默认）；
      // 用户自建片段（{{custom.xxx}}）同样两种模式都可引用。
      const modeRow = conv.modeId
        ? await this.prisma.agentMode.findFirst({
            where: { id: conv.modeId, userId: conv.userId },
          })
        : null;
      const generalSetting = modeRow
        ? null
        : await this.prisma.generalModeSetting.findUnique({
            where: { userId: conv.userId },
            select: { systemPrompt: true },
          });
      const [fragmentOverrides, customFragments] = await Promise.all([
        this.modes.fragmentOverrides(conv.userId),
        this.modes.customFragments(conv.userId),
      ]);
      const env = backendEnvironment(sandbox);
      const mcpServers = await this.mcp.runtimeServers(conv.userId);
      const assembly = resolveMode({
        mode: modeRow ? toAgentMode(modeRow) : null,
        generalPrompt: generalSetting?.systemPrompt ?? null,
        fragmentOverrides,
        customFragments,
        registry: this.registry,
        env,
        installedSkills: defs,
        mcpServers,
        envPromptBlock: backendEnvPromptBlock(env.workspace),
      });

      // ③.5 挂载技能（只挂模式勾选的）：有沙箱写进沙箱盘（deepagents skills 中间件随后扫 skillsDir），
      // 上传失败只告警不中断（沙箱仍可执行命令，仅本轮无技能）；无沙箱灌进内存只读 store。
      let backend: Awaited<ReturnType<typeof mountSkills>>['backend'];
      if (sandbox) {
        try {
          backend = (
            await mountSkills({
              strategy: 'sandbox',
              sandbox,
              skills: assembly.skills,
            })
          ).backend;
        } catch (e) {
          this.logger.warn(
            `技能上传沙箱失败，本轮无技能：${(e as Error)?.message ?? e}`,
          );
          backend = sandbox;
        }
      } else {
        backend = (
          await mountSkills({
            strategy: 'memory',
            skillsDir: env.skillsDir,
            skills: assembly.skills,
          })
        ).backend;
      }

      // resume 续跑沿用 checkpointer 的中断态；run/追加则从 DB 重放完整对话历史，
      // 因为 deepagents 跑完一轮后不在持久化 state 保留对话消息（同 thread_id 续跑拿不到上文）。
      let runName = `审批续跑 · ${conversationId}`;
      let input: unknown;
      // run 内稳定的静态尾段（/command 激活技能的全文），接在装配出的系统提示之后
      let skillPromptExtra = '';
      if (kind === 'resume') {
        input = new Command({ resume: { decisions } });
      } else {
        const messages = await this.loadHistory(conversationId);
        // 历史按原样重放，不改写任何用户消息：/command 该触发哪个技能由 system prompt 约束
        // （见 prompt-fragments 的 platform.slash_command）。技能文件已在上方 mountSkills 挂好，
        // 不再注入 state.files。这里只取末条 user 消息做 LangSmith runName。
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
        // 只认当前模式勾选的技能：模式外的 /技能名 当普通文本（不注入全文）
        skillPromptExtra = await buildSkillPrompt(
          messages.filter((m) => m.role === 'user').map((m) => m.content),
          (name) =>
            assembly.skills.find((s) => s.name === name)?.files['SKILL.md'] ??
            null,
          env.skillsDir,
        );
      }

      // 既有任务计划经 runtime context 注入：activePlanProvider 会把它追加到系统提示
      // **末尾**（盖过 todoListMiddleware 的「随时重订」），根治多轮 todos 被整表替换、没执行完
      // 就换新列表。run/resume 都注入（resume 续跑同一轮，回注既有计划同样有益）。
      const lastPlan = await this.prisma.message.findFirst({
        where: { conversationId, type: 'plan_update' },
        orderBy: { seq: 'desc' },
        select: { content: true },
      });
      const activePlan = buildActivePlan(lastPlan?.content);

      // ④ 建工具实例：描述符闭包里拿到 conversationId/userId（不经模型传递，无注入风险）、
      // 本轮沙箱与 MCP server 清单；需审批的（send_email、MCP ask）并进 interruptOn。
      const { tools, interruptOn } = instantiateTools(
        assembly,
        {
          conversationId,
          userId: conv.userId,
          env,
          host: { sandbox, mcpServers: assembly.mcpServers },
        },
        (serverId, name, args) =>
          this.mcp.callTool(conv.userId, serverId, name, args),
      );

      // 动态尾段：每次模型调用前取，只改发给模型的那份。媒体清单 / MCP App 上下文在同一 run 内
      // 不会变（App 上下文由上一轮写入会话），闭包里缓存首次结果避免每次模型调用重查。
      const mediaInventory = this.memo(() =>
        this.buildMediaInventory(conversationId, conv.userId),
      );
      const mcpAppContext = buildMcpPrompt(
        [],
        appContextOf(conv.mcpAppContext),
      ).trim();
      const dynamicContext: DynamicContextProvider[] = [
        activePlanProvider,
        async () => {
          const text = await mediaInventory();
          return text ? [{ placement: 'system_tail', text }] : null;
        },
        () =>
          mcpAppContext
            ? [{ placement: 'system_tail', text: mcpAppContext }]
            : null,
      ];

      const agent = await buildAgent({
        checkpointer: this.checkpointer,
        systemPrompt: assembly.systemPrompt + skillPromptExtra,
        tools,
        interruptOn,
        backend,
        skillsDir: env.skillsDir,
        model: conv.model ?? undefined,
        thinkingLevel: asThinkingLevel(conv.thinkingLevel),
        dynamicContext,
      });

      // ④ stream config：userId 进 configurable（thread 作用域）与 context（中间件用）
      // runName/tags/metadata → LangSmith 里按此命名/过滤，而非只显示 "LangGraph"
      const stream = await agent.stream(input, {
        ...config,
        signal, // stop 端点 abort 后整条 runnable 链中止（RunnableConfig.signal）
        runName,
        tags: ['spark', kind ?? 'run'],
        metadata: { conversationId, kind: kind ?? 'run' },
        context: { activePlan, userId: conv.userId },
        streamMode: ['updates', 'messages'],
        subgraphs: true,
      });

      // resume 续跑时从已有消息数接着排 seq
      let seq = await this.prisma.message.count({ where: { conversationId } });
      // token 会计（同画布）：本轮归属的用户消息、已记账的 AIMessage id（跨 run 幂等）、会话累计起点
      const usage = await this.prepareUsage(conversationId);
      // 流的消费规则（文本段收口、思考归集、token 记账、停止时收口残余文本）都在 core 的
      // consumeAgentStream；这里只给落点：推 Redis Stream、写 message 表、写 token 明细表。
      await consumeAgentStream(
        stream,
        {
          emit: (event) => this.stream.publish(conversationId, event),
          persist: (event) => this.persist(conversationId, event, seq++),
          recordUsage: (call) => this.recordUsage(conversationId, usage, call),
        },
        {
          // run 开始前 checkpoint 里就有的消息：审批 resume 时 updates 会整批回放，其思考已落过库
          priorIds: await priorMessageIds(agent, config, () =>
            this.logger.warn(
              'priorMessageIds 读取 checkpoint 失败，本轮不排除历史思考',
            ),
          ),
          seenUsageIds: usage.seen,
          // provider 没回模型名时（google-genai）的回落值：与 buildAgent 实际装配的模型同一口径
          fallbackModel: resolveModelName(conv.model),
          signal,
        },
      );

      // 流结束后检测审批中断
      const interrupt = readInterrupt(await agent.getState(config));
      if (interrupt) {
        const { value, toolName: interruptToolName } = interrupt;
        this.logger.log(
          `conversation=${conversationId} 命中审批中断，等待用户决策`,
        );
        // CAS：流自然结束后、走到这里前被停止（status 已是 stopped）→ 不进审批流程，按停止收尾
        const toApproval = await this.prisma.conversation.updateMany({
          where: { id: conversationId, status: 'running' },
          data: { status: 'waiting_approval' },
        });
        if (toApproval.count === 0) {
          await this.finalizeStopped(conversationId);
          return;
        }
        const evt: RawEvent = { type: 'control_request', payload: value };
        await this.stream.publish(conversationId, evt);
        await this.persist(conversationId, evt, seq++);
        // 超时行为/时长按中断的工具分叉：ask_user 用长兜底（前端 60s 倒计时是主路径），
        // 其余（send_email 等审批）维持短超时自动拒绝
        await this.queue.add(
          'timeout',
          { conversationId, kind: 'timeout', toolName: interruptToolName },
          {
            delay:
              interruptToolName === 'ask_user'
                ? ASK_USER_TIMEOUT_MS
                : TIMEOUT_MS,
          },
        );
        return; // job 结束，释放 worker slot
      }

      // CAS：流自然结束后、走到这里前被停止 → 不覆盖 stopped 终态，按停止收尾
      const toDone = await this.prisma.conversation.updateMany({
        where: { id: conversationId, status: 'running' },
        data: { status: 'done' },
      });
      if (toDone.count === 0) {
        await this.finalizeStopped(conversationId);
        return;
      }
      // 持久化 result：历史据此收尾未完成的工具卡、置为 done；实时丢失/重连也能从历史对齐。
      const resultEvt: RawEvent = {
        type: 'result',
        payload: { status: 'done' },
      };
      await this.stream.publish(conversationId, resultEvt);
      await this.persist(conversationId, resultEvt, seq++);
      this.logger.log(`agent 完成: conversation=${conversationId}`);
      // 本轮运行期间结束的后台任务：通知当时挂着没投（会话忙），现在空闲了投递并唤醒下一轮
      await this.background
        .deliverPending(conversationId)
        .catch((e: unknown) =>
          this.logger.warn(`投递后台任务通知失败：${String(e)}`),
        );
    } catch (e) {
      // 用户主动停止：AbortError 不是失败——残余文本已由 consumeAgentStream 收口落库，
      // 这里只发 stopped result（状态已由端点置好）
      if (signal.aborted) {
        this.logger.log(`agent 停止: conversation=${conversationId}`);
        await this.finalizeStopped(conversationId);
        return;
      }
      this.logger.error(
        `agent 失败: conversation=${conversationId} ${String(e)}`,
      );
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
      const seq = await this.prisma.message.count({
        where: { conversationId },
      });
      await this.persist(conversationId, errorEvt, seq);
    } finally {
      clearInterval(heartbeat);
      dispose();
    }
  }

  /**
   * 本轮 token 会计的起点：
   * - turnMessageId：触发本轮的用户消息（最新一条）。审批 resume 也是续这一轮，报表按它分轮；
   * - seen：已落库的 AIMessage id。checkpointer 恢复会把历史 AIMessage 重新 emit 到 updates 流，
   *   只靠 run 内去重拦不住（画布实测过重复记账），用落库的 id 预热；
   * - total：会话已有累计，token_usage 事件的 cumulativeTotal 因此是会话级口径。
   * 统计失败不阻断运行：任何一步出错都退化成「从零起、本轮不分轮」。
   */
  private async prepareUsage(conversationId: string): Promise<UsageContext> {
    try {
      const [turn, rows, agg] = await Promise.all([
        this.prisma.message.findFirst({
          where: { conversationId, role: 'user', type: 'message' },
          orderBy: { seq: 'desc' },
          select: { id: true },
        }),
        this.prisma.conversationTokenUsage.findMany({
          where: { conversationId, messageId: { not: null } },
          select: { messageId: true },
        }),
        this.prisma.conversationTokenUsage.aggregate({
          where: { conversationId },
          _sum: { totalTokens: true },
        }),
      ]);
      return {
        turnMessageId: turn?.id ?? conversationId,
        seen: new Set(rows.flatMap((r) => (r.messageId ? [r.messageId] : []))),
        total: agg._sum.totalTokens ?? 0,
      };
    } catch (e) {
      this.logger.warn(`token 会计初始化失败（本轮照常运行）：${String(e)}`);
      return { turnMessageId: conversationId, seen: new Set(), total: 0 };
    }
  }

  /**
   * 记一次模型调用的 token 明细，返回记账后的会话累计（token_usage 事件由 consumeAgentStream 推）。
   * 唯一键冲突（同一 AIMessage 已记过，如并发重放）= 已计入，返回 null 不推流；其余失败只记日志。
   */
  private async recordUsage(
    conversationId: string,
    ctx: UsageContext,
    call: CallUsage,
  ): Promise<number | null> {
    try {
      await this.prisma.conversationTokenUsage.create({
        data: {
          conversationId,
          turnMessageId: ctx.turnMessageId,
          messageId: call.messageId,
          model: call.model,
          inputTokens: call.input,
          outputTokens: call.output,
          totalTokens: call.total,
          cacheReadTokens: call.cacheRead,
          cacheCreationTokens: call.cacheCreation,
        },
      });
    } catch (e) {
      if (
        !(
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
      ) {
        this.logger.warn(`token 明细落库失败：${String(e)}`);
      }
      return null;
    }
    ctx.total += call.total;
    return ctx.total;
  }

  /**
   * 停止收尾：补发并持久化 result{status:'stopped'}（流式残余文本已由 consumeAgentStream 收口落库）。
   * 会话状态已由 stop 端点 CAS 置为 stopped，此处不改写（设计 §竞态规则）。
   */
  private async finalizeStopped(conversationId: string) {
    const seq = await this.prisma.message.count({ where: { conversationId } });
    const evt: RawEvent = { type: 'result', payload: { status: 'stopped' } };
    await this.stream.publish(conversationId, evt);
    await this.persist(conversationId, evt, seq);
    this.logger.log(`agent 已停止收尾: conversation=${conversationId}`);
  }

  /**
   * 从 DB 重放该会话的完整对话历史（按 seq；窗口与 tool_end 的处理见 core historyFromRows）。
   * 用户消息带附件时，末尾拼一段「[附件]」清单（见 userMessageText）。
   */
  private async loadHistory(conversationId: string): Promise<HistoryMessage[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        type: { in: ['message', 'tool_end'] },
        role: { in: ['user', 'assistant', 'tool'] },
      },
      orderBy: { seq: 'asc' },
      select: { role: true, content: true, type: true, seq: true },
    });
    return historyFromRows(rows, userMessageText);
  }

  /** 同一 run 内只算一次的异步值（动态上下文 provider 每次模型调用都会跑）。 */
  private memo<T>(fn: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | undefined;
    return () => (pending ??= fn());
  }

  /**
   * 构建本会话已生成的媒体资产清单，经动态上下文 provider 接到系统提示末尾，让模型正确引用
   * versionId、避免编造。空会话（无生成位）返回空串，不注入。
   */
  private async buildMediaInventory(
    conversationId: string,
    userId: string,
  ): Promise<string> {
    const generations = await this.media.listForConversation(
      conversationId,
      userId,
    );
    if (!generations || generations.length === 0) return '';

    const lines = generations
      .map((g) => {
        const v = g.versions[0]; // 最新版本（已按 createdAt desc）
        if (!v) return null;
        // 用户上传的素材：prompt 存的是文件名
        if (v.model === UPLOAD_MODEL) {
          return `- versionId=${v.id} [${g.type}][upload] 文件名 ${v.prompt}`;
        }
        const promptPreview =
          v.prompt.slice(0, 40) + (v.prompt.length > 40 ? '…' : '');
        return `- versionId=${v.id} [${g.type}][${v.status}] ${promptPreview}`;
      })
      .filter(Boolean)
      .join('\n');
    if (!lines) return '';

    return (
      `## 本会话的媒体资产（生成的与用户上传的；引用素材必须用此表的 versionId）\n${lines}\n` +
      `规则：referenceVersionIds 只能填上表或生成工具结果中的真实 versionId（cuid 格式），禁止自造名称；表中已有的资产不要重复生成；[upload] 是用户上传的素材，不能重新生成。`
    );
  }

  /**
   * 超时兜底：CAS 抢占成功后按工具分叉续跑（用户已决策则 CAS 失败、忽略）。
   * - ask_user → approve：tool 执行返回建议答案（auto:true），即「自动采纳建议」。
   * - 其余（send_email 等审批、旧 job 无 toolName）→ reject，维持原行为。
   */
  private async handleTimeout(
    conversationId: string,
    toolName?: string,
  ): Promise<void> {
    const cas = await this.prisma.conversation.updateMany({
      where: { id: conversationId, status: 'waiting_approval' },
      data: { status: 'running' },
    });
    if (cas.count === 0) return; // 用户已决策，无需超时处理

    const isAskUser = toolName === 'ask_user';
    this.logger.warn(
      `conversation=${conversationId} ${isAskUser ? '等待回答超时，自动采纳建议答案' : '审批超时，自动拒绝'}`,
    );
    await this.prisma.approval.create({
      data: {
        conversationId,
        decision: 'timeout',
        payload: {
          reason: isAskUser ? 'ask_user_timeout' : 'approval_timeout',
        },
      },
    });
    await this.stream.publish(conversationId, {
      type: 'message',
      payload: {
        text: isAskUser
          ? '⏱ 等待回答超时，已自动采用建议答案。'
          : '⏱ 审批超时，已自动拒绝该操作。',
      },
    });
    await this.queue.add('resume', {
      conversationId,
      kind: 'resume',
      decisions: [{ type: isAskUser ? 'approve' : 'reject' }],
    });
  }

  private async persist(conversationId: string, raw: RawEvent, seq: number) {
    await this.prisma.message.create({
      data: {
        conversationId,
        role: roleOf(raw.type),
        type: raw.type,
        content: raw.payload as object,
        seq,
      },
    });
  }
}
