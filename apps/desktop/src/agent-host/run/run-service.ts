/**
 * RunService：agent-host 里一轮对话的编排（desktop 版 AgentProcessor）。
 *
 * 步骤与 backend worker（apps/backend/src/worker/agent.processor.ts）一一对应：
 * 置 running → 技能同步进工作区 → 从 message 表重放历史 / 解析 /command → 计划延续 →
 * 装配 MCP 工具与提示词 → buildAgent → 流式运行（逐字推流、按文本段落库、思考按源消息归并、
 * token 记账）→ 结束态 done / waiting_approval / failed / stopped。
 *
 * 与 backend 的差异：不排队（同一会话同时只跑一轮，第二次 start 直接拒绝）；执行环境是会话自选的
 * 本机目录（见 workspace/workspace-backend.ts），按会话权限档位决定写 / 执行是否审批或直接拒绝；
 * 审批没有超时自动拒绝。
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { buildAgent } from '@agent-test/agent-core/agent/agent.factory';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { resolveModelName } from '@agent-test/agent-core/agent/models';
import { asThinkingLevel } from '@agent-test/agent-core/agent/thinking-level';
import { parseCommand } from '@agent-test/agent-core/commands/parse-command';
import type { RuntimeEnvironment } from '@agent-test/agent-core/modes/capabilities';
import {
  activePlanProvider,
  type DynamicContextProvider,
} from '@agent-test/agent-core/modes/dynamic-context';
import { instantiateTools, resolveMode } from '@agent-test/agent-core/modes/resolve-mode';
import { priorMessageIds, readInterrupt } from '@agent-test/agent-core/run/agent-state';
import { consumeAgentStream } from '@agent-test/agent-core/run/consume-stream';
import { historyFromRows, type HistoryMessage, roleOf } from '@agent-test/agent-core/run/history';
import { buildActivePlan, buildSkillPrompt } from '@agent-test/agent-core/run/turn-prompts';
import type { HitlDecision } from '../../shared/rpc';
import type { NodeSqliteSaver } from '../db/checkpointer';
import type { ConversationRepo } from '../db/conversations';
import type { McpStore } from '../mcp/mcp-store';
import { hostI18n } from '../i18n';
import type { BackgroundService } from '../background/background-service';
import type { ModeStore } from '../modes/mode-store';
import { parseSkillSource, skillsAddArgs } from '../skills/github-install';
import type { WebApi } from '../web-media/web-api';
import { uploadAttachment } from '../web-media/web-media';
import type { SkillStore } from '../skills/skill-store';
import { LocalWorkspaceSandbox } from '../workspace/local-sandbox';
import type { ProcessTracker } from '../workspace/process-tracker';
import { buildWorkspaceBackend, permissionInterrupts } from '../workspace/workspace-backend';
import { copyAttachments, userTextForModel } from './attachments';
import {
  DESKTOP_ATTACHMENTS_SECTION,
  DESKTOP_MEDIA_ATTACHMENTS_NOTE,
  localWorkspaceBlock,
  mcpAppContextBlock,
} from './prompts';
import { type DesktopRegistry, desktopCapabilities } from './tool-registry';

/** 桌面端单用户：contextSchema 要求 userId 必填，固定传这个值 */
export const LOCAL_USER_ID = 'local';

export interface RunConfig {
  /** 新会话默认工作区（会话自己的目录在 conversation.workspaceDir） */
  workspaceDir: string;
  defaultModel: string;
  /** 各会话运行目录的父目录（`<userData>/runtime`）：技能同步与附件副本放这里 */
  runtimeRoot: string;
}

export interface RunDeps {
  repo: ConversationRepo;
  checkpointer: NodeSqliteSaver;
  skills: SkillStore;
  mcp: McpStore;
  /** 会话所选模式（被删 → 按通用模式跑） */
  modes: ModeStore;
  /** desktop 工具注册表（启动时登记一次，见 tool-registry.ts） */
  registry: DesktopRegistry;
  /** 命令登记表（崩溃后清理孤儿进程）；测试里可不传 */
  processes?: ProcessTracker;
  config: () => RunConfig;
  /** 推给所有已连接的 renderer */
  emit: (conversationId: string, event: RawEvent) => void;
  listChanged: () => void;
  /** 技能库变了（save_skill / /skills add）：刷新技能页与 / 补全 */
  skillsChanged?: () => void;
  /** 登录了 Web 账号：挂载生图 / 生视频 / 配音工具，附件同时上传为生成素材 */
  webApi?: WebApi | null;
  log?: (msg: string) => void;
}

interface ActiveRun {
  abort: AbortController;
  sandbox: LocalWorkspaceSandbox;
}

export class BusyError extends Error {}

export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  /** 后台任务（与 RunService 互相引用：任务结束要唤醒新一轮，一轮结束要补投通知），装配后注入 */
  private background: BackgroundService | null = null;

  constructor(private readonly deps: RunDeps) {}

  setBackground(bg: BackgroundService): void {
    this.background = bg;
  }

  /** 后台任务通知已写进会话、会话已被 CAS 置为 running：开跑新的一轮（模型从历史里读到 <task-notification>） */
  runClaimed(conversationId: string): void {
    this.deps.listChanged();
    void this.execute(conversationId, 'run');
  }

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  /** 会话运行目录：`<runtimeRoot>/<会话 id>`（skills/ + attachments/，agent 只读） */
  runtimeDir(conversationId: string): string {
    return join(this.deps.config().runtimeRoot, conversationId);
  }

  /** 删除会话时一并清掉它在 checkpointer 里的中断态与运行目录（附件副本） */
  async forgetThread(conversationId: string): Promise<void> {
    await this.deps.checkpointer.deleteThread(conversationId);
    await rm(this.runtimeDir(conversationId), { recursive: true, force: true });
  }

  /** 记下用户消息并在后台开跑；附件复制失败等前置错误直接抛给调用方 */
  async start(conversationId: string, text: string, attachmentPaths: string[]): Promise<void> {
    const { repo } = this.deps;
    const conv = repo.require(conversationId);
    if (this.active.has(conversationId) || conv.status === 'running') {
      throw new BusyError(hostI18n.t('errors.run.busy'));
    }
    if (!text.trim() && attachmentPaths.length === 0) throw new Error(hostI18n.t('errors.run.emptyMessage'));
    const attachments = await copyAttachments(
      join(this.runtimeDir(conversationId), 'attachments'),
      attachmentPaths,
    );
    // 登录 Web 账号时，图片 / 视频 / 音频附件同时上传为生成素材（失败不挡发送：本机副本照样可用）
    const api = this.deps.webApi;
    if (api) {
      for (const a of attachments) {
        try {
          const up = await uploadAttachment(api, conversationId, a.path, a.filename);
          if (up) Object.assign(a, { versionId: up.versionId, mediaType: up.type, url: up.url });
        } catch (e) {
          this.deps.log?.(`附件上传为生成素材失败 ${a.filename}：${String(e)}`);
        }
      }
    }
    repo.appendMessage(conversationId, 'user', 'message', { text, attachments });
    if (!conv.goal) {
      repo.update(conversationId, {
        goal: text.trim() || attachments.map((a) => a.filename).join(', '),
      });
    }
    // 等审批时又发了新消息：放弃那次中断（与 backend 一致，新消息开新一轮）
    repo.setStatus(conversationId, 'running');
    this.deps.listChanged();
    const installArgs = skillsAddArgs(text);
    if (installArgs !== null) {
      void this.installSkillsCommand(conversationId, installArgs);
      return;
    }
    void this.execute(conversationId, 'run');
  }

  /**
   * `/skills add …`（兼容 npx skills add 写法）：不交给模型，直接从 GitHub 安装，把结果作为助手消息回在对话里。
   * 失败也落一条说明（不标会话失败：这是一次命令，不是 agent 运行）。
   */
  private async installSkillsCommand(conversationId: string, args: string): Promise<void> {
    const { repo, emit } = this.deps;
    const say = (text: string) => {
      const msg: RawEvent = { type: 'message', payload: { text } };
      emit(conversationId, msg);
      repo.appendMessage(conversationId, 'assistant', 'message', msg.payload);
    };
    try {
      const installed = await this.deps.skills.installFromGithub(parseSkillSource(args));
      this.deps.skillsChanged?.();
      say(
        `${hostI18n.t('errors.skills.installed', { count: installed.length })}\n\n` +
          installed.map((s) => `- \`/${s.name}\` — ${s.description}`).join('\n') +
          `\n\n${hostI18n.t('errors.skills.installedHint')}`,
      );
    } catch (e) {
      say(hostI18n.t('errors.skills.installFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
    if (repo.transition(conversationId, ['running'], 'done')) {
      const evt: RawEvent = { type: 'result', payload: { status: 'done' } };
      emit(conversationId, evt);
      repo.appendMessage(conversationId, 'assistant', 'result', evt.payload);
    }
    this.deps.listChanged();
  }

  resume(conversationId: string, decisions: HitlDecision[]): void {
    const { repo } = this.deps;
    if (!repo.transition(conversationId, ['waiting_approval'], 'running')) {
      throw new BusyError(hostI18n.t('errors.run.noPendingApproval'));
    }
    for (const d of decisions) repo.recordApproval(conversationId, d.type, d);
    this.deps.listChanged();
    void this.execute(conversationId, 'resume', decisions);
  }

  stop(conversationId: string): void {
    const { repo } = this.deps;
    // 停止 = 停止所有操作：一并取消这个会话的后台任务（同 backend ConversationsService.stop）
    this.background?.cancelByConversation(conversationId);
    const changed = repo.transition(conversationId, ['running', 'waiting_approval'], 'stopped');
    const run = this.active.get(conversationId);
    if (run) {
      run.abort.abort();
      void run.sandbox.stop();
      return; // execute 的 catch / CAS 分支负责发 stopped result
    }
    if (changed) this.finalizeStopped(conversationId);
  }

  // ── 一轮运行 ─────────────────────────────────────────────────────────────

  private async execute(
    conversationId: string,
    kind: 'run' | 'resume',
    decisions?: HitlDecision[],
  ): Promise<void> {
    const { repo, emit } = this.deps;
    const cfg = this.deps.config();
    const abort = new AbortController();
    // execute 以 void 方式后台调用：会话在开跑前被删掉就直接放弃，不能抛成未处理的 rejection
    const conv = repo.get(conversationId);
    if (!conv) return;
    const workspaceDir = conv.workspaceDir;
    const runtimeDir = this.runtimeDir(conversationId);
    const inner = new LocalWorkspaceSandbox(workspaceDir, { tracker: this.deps.processes });
    this.active.set(conversationId, { abort, sandbox: inner });
    /** 本轮正常结束：收尾后补投运行期间结束的后台任务通知（同 backend worker 在 done 之后 deliverPending） */
    let deliverAfter = false;
    const persist = (raw: RawEvent) =>
      repo.appendMessage(conversationId, roleOf(raw.type), raw.type, raw.payload);
    try {
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      const { backend, skillsDir } = buildWorkspaceBackend({
        inner,
        workspaceDir,
        runtimeDir,
        permission: conv.permission,
      });
      const config = { configurable: { thread_id: conversationId, userId: LOCAL_USER_ID } };

      // ── 按模式装配（core resolveMode 纯函数）：模式被删 → null = 通用模式 ──
      const mode = conv.modeId ? this.deps.modes.get(conv.modeId) : null;
      const webApi = this.deps.webApi ?? null;
      const env: RuntimeEnvironment = {
        capabilities: desktopCapabilities({ permission: conv.permission, webApi, background: this.background }),
        workspace: workspaceDir,
        skillsDir,
      };
      const assembly = resolveMode({
        mode,
        // 通用模式用用户覆盖的提示词（没覆盖为 null → core 默认）；有模式时 core 不看它
        generalPrompt: mode ? null : this.deps.modes.getGeneral().systemPrompt,
        // 用户改写过的平台片段（通用模式与普通模式都生效）
        fragmentOverrides: this.deps.modes.fragmentOverrides(),
        // 用户自建片段（{{custom.xxx}}）
        customFragments: this.deps.modes.customFragments(),
        registry: this.deps.registry,
        env,
        installedSkills: await this.deps.skills.listFiles(),
        mcpServers: this.deps.mcp.runtimeServers(),
        envPromptBlock:
          localWorkspaceBlock({ skillsDir, permission: conv.permission })(workspaceDir) +
          DESKTOP_ATTACHMENTS_SECTION +
          (webApi ? DESKTOP_MEDIA_ATTACHMENTS_NOTE : ''),
        // 后台任务说明是后台工具的 promptSection，随勾选与环境走（见 tool-registry.ts）
      });
      const skillNames = assembly.skills.map((s) => s.name);

      try {
        await this.deps.skills.syncToRuntime(runtimeDir, skillNames);
      } catch (e) {
        emit(conversationId, {
          type: 'message',
          payload: { text: hostI18n.t('errors.run.skillSyncFailed', { error: String(e) }) },
        });
      }

      let input: unknown;
      let systemPromptExtra = '';
      let runName = `审批续跑 · ${conversationId}`;
      if (kind === 'resume') {
        input = new Command({ resume: { decisions } });
      } else {
        const messages = await this.loadHistory(conversationId);
        const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
        const last = userTexts[userTexts.length - 1] ?? '';
        const cmd = parseCommand(last);
        runName = cmd ? `技能:${cmd.name} · ${cmd.args}`.slice(0, 60) : `Agent · ${last.slice(0, 60)}`;
        input = { messages };
        // /技能名 不在当前模式技能集内：当普通文本（决策 15），不注入其 SKILL.md
        systemPromptExtra = await buildSkillPrompt(
          userTexts,
          (name) => (skillNames.includes(name) ? this.deps.skills.skillMd(name) : Promise.resolve(null)),
          skillsDir,
        );
      }
      const activePlan = buildActivePlan(repo.lastOfType(conversationId, 'plan_update')?.content);
      const { tools, interruptOn } = instantiateTools(
        assembly,
        {
          conversationId,
          userId: LOCAL_USER_ID,
          env,
          host: { workspaceDir, runtimeDir, permission: conv.permission, mcpServers: assembly.mcpServers },
        },
        (sid, name, args) => this.deps.mcp.callTool(sid, name, args),
      );
      // MCP 卡片上下文随对话变化：每次模型调用前现取（不进静态提示，见 prompts.mcpAppContextBlock）
      const mcpAppContextProvider: DynamicContextProvider = () => {
        const text = mcpAppContextBlock(this.deps.mcp.appContext(conversationId));
        return text ? [{ placement: 'system_tail', text }] : null;
      };

      const agent = await buildAgent({
        // /command 激活技能的全文是 run 内稳定的静态尾段，接在装配结果之后
        systemPrompt: assembly.systemPrompt + systemPromptExtra,
        tools,
        interruptOn,
        interruptOnOverride: permissionInterrupts(conv.permission),
        backend,
        skillsDir,
        model: conv.model ?? cfg.defaultModel,
        thinkingLevel: asThinkingLevel(conv.thinkingLevel),
        checkpointer: this.deps.checkpointer,
        dynamicContext: [activePlanProvider, mcpAppContextProvider],
      });

      const stream = await agent.stream(input, {
        ...config,
        signal: abort.signal,
        runName,
        tags: ['spark-desktop', kind],
        metadata: { conversationId, kind },
        context: { activePlan, userId: LOCAL_USER_ID },
        streamMode: ['updates', 'messages'],
        subgraphs: true,
      });

      const turnMessageId = repo.lastUserMessageId(conversationId) ?? conversationId;
      let total = repo.totalTokens(conversationId);
      // 流的消费规则（文本段收口、思考归集、token 记账、停止时收口残余文本）都在 core 的
      // consumeAgentStream；这里只给落点：推给 renderer、写 message 表、写 token_usage 表。
      await consumeAgentStream(
        stream,
        {
          emit: (event) => emit(conversationId, event),
          persist: (event) => {
            persist(event);
          },
          recordUsage: (call) => {
            if (!repo.recordUsage({ conversationId, turnMessageId, ...call })) return null;
            total += call.total;
            return total;
          },
        },
        {
          // run 开始前 checkpoint 里已有的消息：审批续跑时 updates 会整批回放，其思考已落过库
          priorIds: await priorMessageIds(agent, config, () =>
            this.deps.log?.('priorMessageIds 读取 checkpoint 失败，本轮不排除历史思考'),
          ),
          seenUsageIds: repo.usageMessageIds(conversationId),
          fallbackModel: resolveModelName(conv.model ?? cfg.defaultModel),
          signal: abort.signal,
        },
      );

      const interrupt = readInterrupt(await agent.getState(config));
      if (interrupt) {
        if (!repo.transition(conversationId, ['running'], 'waiting_approval')) {
          this.finalizeStopped(conversationId);
          return;
        }
        const evt: RawEvent = { type: 'control_request', payload: interrupt.value };
        emit(conversationId, evt);
        persist(evt);
        this.deps.log?.(`conversation=${conversationId} 等待审批 ${interrupt.toolName ?? ''}`);
        return;
      }
      if (!repo.transition(conversationId, ['running'], 'done')) {
        this.finalizeStopped(conversationId);
        return;
      }
      const resultEvt: RawEvent = { type: 'result', payload: { status: 'done' } };
      emit(conversationId, resultEvt);
      persist(resultEvt);
      deliverAfter = true;
    } catch (e) {
      // 用户停止：残余文本已由 consumeAgentStream 收口落库，这里只补发 result{stopped}
      if (abort.signal.aborted) {
        this.finalizeStopped(conversationId);
        return;
      }
      this.deps.log?.(`agent 失败 conversation=${conversationId}: ${String(e)}`);
      repo.setStatus(conversationId, 'failed');
      const errorEvt: RawEvent = {
        type: 'error',
        payload: { message: e instanceof Error ? e.message : String(e) },
      };
      emit(conversationId, errorEvt);
      persist(errorEvt);
    } finally {
      this.active.delete(conversationId);
      await inner.stop();
      this.deps.listChanged();
      // 会话现在空闲：当时没投出去的后台任务通知写进会话并唤醒新一轮
      if (deliverAfter) this.background?.deliverPending(conversationId);
    }
  }

  /** 停止收尾：补发并落库 result{stopped}（流式残余文本已由 consumeAgentStream 收口落库） */
  private finalizeStopped(conversationId: string): void {
    const { repo, emit } = this.deps;
    const evt: RawEvent = { type: 'result', payload: { status: 'stopped' } };
    emit(conversationId, evt);
    repo.appendMessage(conversationId, 'assistant', 'result', evt.payload);
  }

  /** 从 message 表重放完整对话历史（窗口与 tool_end 的处理见 core historyFromRows） */
  private loadHistory(conversationId: string): Promise<HistoryMessage[]> {
    return historyFromRows(this.deps.repo.messages(conversationId), userTextForModel);
  }
}
