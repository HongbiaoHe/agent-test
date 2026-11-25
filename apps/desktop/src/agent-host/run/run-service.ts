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
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Command } from '@langchain/langgraph';
import { createCanvasStateMiddleware } from '@agent-test/agent-core/canvas/canvas-state-middleware';
import { buildAgent, type ModelResolver } from '@agent-test/agent-core/agent/agent.factory';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { parseModelRef } from '@agent-test/agent-core/providers/model-ref';
import { asThinkingLevel } from '@agent-test/agent-core/agent/thinking-level';
import { parseCommand } from '@agent-test/agent-core/commands/parse-command';
import type { RuntimeEnvironment } from '@agent-test/agent-core/modes/capabilities';
import {
  activePlanProvider,
  type DynamicContextProvider,
} from '@agent-test/agent-core/modes/dynamic-context';
import { instantiateTools, mountableSkills, resolveMode } from '@agent-test/agent-core/modes/resolve-mode';
import { priorMessageIds, readInterrupt } from '@agent-test/agent-core/run/agent-state';
import { compactHistory } from '@agent-test/agent-core/run/compaction';
import { AGENT_STREAM_MODES, consumeAgentStream } from '@agent-test/agent-core/run/consume-stream';
import { historyFromRows, type ReplayHistory, roleOf } from '@agent-test/agent-core/run/history';
import { createSteeringMiddleware, type SteeringMessage } from '@agent-test/agent-core/run/steering';
import { buildActivePlan, buildSkillPrompt } from '@agent-test/agent-core/run/turn-prompts';
import type { AttachmentRef, HitlDecision, PendingKind, PendingMessage } from '../../shared/rpc';
import type { NodeSqliteSaver } from '../db/checkpointer';
import type { ConversationFiles } from '../storage/conversation-files';
import type { ConversationRepo } from '../db/conversations';
import type { McpStore } from '../mcp/mcp-store';
import { hostI18n } from '../i18n';
import type { BackgroundService } from '../background/background-service';
import type { LlmStore } from '../llm/llm-store';
import type { ModeStore } from '../modes/mode-store';
import type { PendingStore } from '../pending/pending-store';
import { parseSkillSource, skillsAddArgs } from '../skills/github-install';
import type { VideoSnapshots } from '../video/snapshots';
import type { WebApi } from '../web-media/web-api';
import { uploadAttachment } from '../web-media/web-media';
import type { SkillStore } from '../skills/skill-store';
import { LocalWorkspaceSandbox } from '../workspace/local-sandbox';
import type { ProcessTracker } from '../workspace/process-tracker';
import { buildWorkspaceBackend, permissionInterrupts } from '../workspace/workspace-backend';
import { copyAttachments, type UserContent, userTextForModel } from './attachments';
import {
  DESKTOP_ATTACHMENTS_SECTION,
  DESKTOP_MEDIA_ATTACHMENTS_NOTE,
  localWorkspaceBlock,
  mcpAppContextBlock,
} from './prompts';
import { type DesktopRegistry, desktopCapabilities } from './tool-registry';
import { CanvasRunSession } from '../canvas/canvas-run';
import type { CanvasRunContext } from '../canvas/canvas-tools';
import { CanvasWeb } from '../canvas/canvas-web';

/** 桌面端单用户：contextSchema 要求 userId 必填，固定传这个值 */
export const LOCAL_USER_ID = 'local';

export interface RunConfig {
  /** 新会话默认工作区（会话自己的目录在 conversation.workspaceDir） */
  workspaceDir: string;
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
  /** 当前账号的 API 连接与模型（会话的模型引用在这里解析，见 llm/llm-store.ts） */
  llm: LlmStore;
  /** 按「连接 id/模型 id」构建模型（Key 来自 main 下发的内存表，见 llm/model-resolver.ts） */
  resolveModel: ModelResolver;
  /** 推给所有已连接的 renderer */
  emit: (conversationId: string, event: RawEvent) => void;
  listChanged: () => void;
  /** 技能库变了（save_skill / /skills add）：刷新技能页与 / 补全 */
  skillsChanged?: () => void;
  /** 登录了 Web 账号：挂载生图 / 生视频 / 配音工具，附件同时上传为生成素材 */
  webApi?: WebApi | null;
  /** agent 改剪辑工程前存快照（剪辑器的「撤销 agent 修改」）；测试里可不传 */
  videoSnapshots?: VideoSnapshots;
  /** 记下会话写过的工作区文件（删会话时清掉它新建的产出）；测试里可不传 */
  files?: ConversationFiles;
  /** 待发消息（运行中插入 / 排队）；不传 = 不支持运行中发消息 */
  pending?: PendingStore;
  /** 某个会话的待发消息变了：通知界面刷新待发列表 */
  pendingChanged?: (conversationId: string) => void;
  log?: (msg: string) => void;
}

interface ActiveRun {
  abort: AbortController;
  sandbox: LocalWorkspaceSandbox;
}

export class BusyError extends Error {}

/** 没有运行、也没有停在审批上的状态：可以开新的一轮 */
const IDLE_STATUSES = ['idle', 'done', 'failed', 'stopped'] as const;

/** 运行中插入的消息落库 / 给模型时带上 injected 标记（给模型的正文前面加固定说明，见 attachments.ts） */
function injectedContent(content: UserContent): UserContent {
  return { ...content, injected: true };
}

export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  /** 每个会话最近一轮 execute 的收尾 promise（stopAndWait 等它） */
  private readonly settling = new Map<string, Promise<void>>();
  /**
   * 停在审批上的对话的画布上下文：运行锁不放（心跳照常），续跑沿用同一个持锁方——
   * 与 Web 画布 agent 等审批时画布仍算忙一致。审批被停止 / 对话被删时释放。
   */
  private readonly parkedCanvas = new Map<string, CanvasRunContext>();
  /** 后台任务（与 RunService 互相引用：任务结束要唤醒新一轮，一轮结束要补投通知），装配后注入 */
  private background: BackgroundService | null = null;

  constructor(private readonly deps: RunDeps) {}

  setBackground(bg: BackgroundService): void {
    this.background = bg;
  }

  /** 后台任务通知已写进会话、会话已被 CAS 置为 running：开跑新的一轮（模型从历史里读到 <task-notification>） */
  runClaimed(conversationId: string): void {
    this.deps.listChanged();
    this.launch(conversationId, 'run');
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
    await this.releaseParkedCanvas(conversationId);
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
    const attachments = await this.receiveAttachments(conversationId, attachmentPaths);
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
    this.launch(conversationId, 'run');
  }

  /** 把用户选的本地文件复制进运行目录；登录了 Web 账号时媒体附件同时上传为生成素材 */
  private async receiveAttachments(conversationId: string, paths: string[]): Promise<AttachmentRef[]> {
    const attachments = await copyAttachments(join(this.runtimeDir(conversationId), 'attachments'), paths);
    // 失败不挡发送：本机副本照样可用
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
    return attachments;
  }

  // ── 运行中发来的消息（插入 / 排队，见 pending/pending-store.ts）───────────────────────────

  private isBusy(conversationId: string): boolean {
    const status = this.deps.repo.get(conversationId)?.status;
    return this.active.has(conversationId) || status === 'running' || status === 'waiting_approval';
  }

  listPending(conversationId: string): PendingMessage[] {
    return (this.deps.pending?.list(conversationId) ?? []).map((e) => e.view);
  }

  /**
   * agent 在跑（或停在审批 / 提问上）的时候用户又发来一条消息：
   * - steer：主 agent 下一次模型调用前作为用户消息插入（不打断正在执行的工具；审批处理完之后才会有下一次调用）；
   * - queue：这一轮结束后发。以 / 开头的命令一律按 queue——/技能名 在一轮开始时把技能全文加进系统提示，
   *   中途加会改掉系统提示（前缀缓存失效），/skills add 也不经过模型。
   * 会话其实已经空闲（界面状态慢了半拍）就当普通消息开跑。
   */
  async enqueue(conversationId: string, text: string, attachmentPaths: string[], kind: PendingKind): Promise<void> {
    const { repo, pending } = this.deps;
    repo.require(conversationId);
    if (!pending || !this.isBusy(conversationId)) {
      await this.start(conversationId, text, attachmentPaths);
      // 界面没有乐观插入这条气泡（它以为在排队）：推一条让它显示出来
      const last = repo.lastOfType(conversationId, 'message');
      if (last?.role === 'user') this.deps.emit(conversationId, { type: 'user_message', payload: last.content });
      return;
    }
    if (!text.trim() && attachmentPaths.length === 0) throw new Error(hostI18n.t('errors.run.emptyMessage'));
    const attachments = await this.receiveAttachments(conversationId, attachmentPaths);
    pending.add(conversationId, text.trimStart().startsWith('/') ? 'queue' : kind, { text, attachments });
    this.deps.pendingChanged?.(conversationId);
    // 复制 / 上传附件期间这一轮可能已经结束了：没人会再来取这条消息，自己接着跑
    if (!this.isBusy(conversationId) && repo.get(conversationId)?.status === 'done') this.continueWithPending(conversationId);
  }

  /** 删除一条待发消息（界面的「编辑」也是先取走再填回输入框）；已送达 / 不存在返回 null */
  removePending(conversationId: string, id: string): PendingMessage | null {
    const entry = this.deps.pending?.get(id);
    if (!entry || entry.conversationId !== conversationId) return null;
    this.deps.pending?.take(id);
    this.deps.pendingChanged?.(conversationId);
    return entry.view;
  }

  /** 会话空闲时（被停止 / 失败 / 重启后）把留着的待发消息作为新一轮发出去 */
  sendPending(conversationId: string): void {
    this.deps.repo.require(conversationId);
    if (this.isBusy(conversationId)) throw new BusyError(hostI18n.t('errors.run.busy'));
    if (!this.continueWithPending(conversationId)) throw new Error(hostI18n.t('errors.run.emptyMessage'));
  }

  /**
   * 本轮这一次模型调用前要插入的消息：所有还没取过的 steer。taken 是本轮已经交给模型的 id——
   * 落库 / 从待发表删除要等它出现在流里（deliverSteered），这之前不能再给第二次。
   */
  private async takeSteering(conversationId: string, taken: Set<string>): Promise<SteeringMessage[]> {
    const out: SteeringMessage[] = [];
    for (const entry of this.deps.pending?.list(conversationId) ?? []) {
      if (entry.view.kind !== 'steer' || taken.has(entry.view.id)) continue;
      taken.add(entry.view.id);
      out.push({ id: entry.view.id, text: await userTextForModel(injectedContent(entry.content)) });
    }
    return out;
  }

  /** 插入的消息已经出现在流里（位置就是它在对话里的位置）：落库、从待发表删掉、推给界面 */
  private deliverSteered(conversationId: string, id: string): void {
    const entry = this.deps.pending?.take(id);
    // 审批续跑会回放 updates：已经送达过的不再处理
    if (!entry) return;
    const content = injectedContent(entry.content);
    this.deps.repo.appendMessage(conversationId, 'user', 'message', content);
    this.deps.emit(conversationId, { type: 'user_message', payload: content });
    this.deps.pendingChanged?.(conversationId);
  }

  /**
   * 用留着的待发消息开新的一轮（没赶上插入的 steer + 所有 queue，按发出顺序合并进同一轮）；没有待发消息返回 false。
   * 调用方保证会话空闲。同时还有没投递的后台任务通知就并进这一轮（通知在前）。
   */
  private continueWithPending(conversationId: string): boolean {
    const { repo, pending, emit } = this.deps;
    if ((pending?.list(conversationId) ?? []).length === 0) return false;
    const conv = repo.require(conversationId);
    // CAS：收尾的这几步 await 之间用户可能已经发了新消息开了新的一轮——那一轮会接手这些待发消息
    if (!repo.transition(conversationId, IDLE_STATUSES, 'running')) return false;
    const entries = pending?.list(conversationId) ?? [];
    this.background?.writeNotifications(conversationId);
    for (const entry of entries) {
      pending?.take(entry.view.id);
      repo.appendMessage(conversationId, 'user', 'message', entry.content);
      emit(conversationId, { type: 'user_message', payload: entry.content });
    }
    if (!conv.goal) {
      const first = entries[0].content;
      repo.update(conversationId, { goal: first.text.trim() || first.attachments.map((a) => a.filename).join(', ') });
    }
    this.deps.pendingChanged?.(conversationId);
    this.deps.listChanged();
    // /skills add 不经过模型：逐条安装；其余的交给 agent 跑一轮（一条普通消息都没有就到此结束）
    const installs = entries.flatMap((e) => {
      const args = skillsAddArgs(e.content.text);
      return args === null ? [] : [args];
    });
    const needsRun = installs.length < entries.length;
    void this.runSkillInstalls(conversationId, installs, needsRun);
    return true;
  }

  private async runSkillInstalls(conversationId: string, installs: string[], thenRun: boolean): Promise<void> {
    for (const args of installs) await this.installSkills(conversationId, args);
    if (thenRun) this.launch(conversationId, 'run');
    else this.finishCommand(conversationId);
  }

  /**
   * `/skills add …`（兼容 npx skills add 写法）：不交给模型，直接从 GitHub 安装，把结果作为助手消息回在对话里。
   * 失败也落一条说明（不标会话失败：这是一次命令，不是 agent 运行）。
   */
  private async installSkillsCommand(conversationId: string, args: string): Promise<void> {
    await this.installSkills(conversationId, args);
    this.finishCommand(conversationId);
  }

  /** 命令执行完（没有 agent 运行）：会话回到 done */
  private finishCommand(conversationId: string): void {
    const { repo, emit } = this.deps;
    if (repo.transition(conversationId, ['running'], 'done')) {
      const evt: RawEvent = { type: 'result', payload: { status: 'done' } };
      emit(conversationId, evt);
      repo.appendMessage(conversationId, 'assistant', 'result', evt.payload);
    }
    this.deps.listChanged();
  }

  private async installSkills(conversationId: string, args: string): Promise<void> {
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
  }

  resume(conversationId: string, decisions: HitlDecision[]): void {
    const { repo } = this.deps;
    if (!repo.transition(conversationId, ['waiting_approval'], 'running')) {
      throw new BusyError(hostI18n.t('errors.run.noPendingApproval'));
    }
    for (const d of decisions) repo.recordApproval(conversationId, d.type, d);
    this.deps.listChanged();
    this.launch(conversationId, 'resume', decisions);
  }

  stop(conversationId: string): void {
    const { repo } = this.deps;
    // 停止 = 停止所有操作：一并取消这个会话的后台任务（同 backend ConversationsService.stop）
    this.background?.cancelByConversation(conversationId);
    const changed = repo.transition(conversationId, ['running', 'waiting_approval'], 'stopped');
    // 停在审批上的那一轮不会再续跑：放掉它一直持有的画布锁
    void this.releaseParkedCanvas(conversationId);
    const run = this.active.get(conversationId);
    if (run) {
      run.abort.abort();
      void run.sandbox.stop();
      return; // execute 的 catch / CAS 分支负责发 stopped result
    }
    if (!changed) return;
    this.finalizeStopped(conversationId);
    // 停在审批上的那一轮不会再续跑：它留着的 checkpoint 一并清掉
    void this.deps.checkpointer.deleteThread(conversationId);
  }

  /**
   * 停止并等这一轮收尾（落库、清 checkpoint、放画布锁、杀子进程）完成。
   * 删会话前调用：否则收尾还会往已删的会话里写消息、重建运行目录。
   */
  async stopAndWait(conversationId: string): Promise<void> {
    this.stop(conversationId);
    await this.settling.get(conversationId);
  }

  // ── 一轮运行 ─────────────────────────────────────────────────────────────

  /** 后台开跑一轮：execute 不被 await，出错只记日志（不能抛成未处理的 rejection 把 agent-host 带崩） */
  private launch(conversationId: string, kind: 'run' | 'resume', decisions?: HitlDecision[]): void {
    const settled = this.execute(conversationId, kind, decisions)
      .catch((e: unknown) => this.deps.log?.(`运行收尾出错 conversation=${conversationId}: ${String(e)}`))
      .finally(() => {
        if (this.settling.get(conversationId) === settled) this.settling.delete(conversationId);
      });
    this.settling.set(conversationId, settled);
  }

  private async execute(
    conversationId: string,
    kind: 'run' | 'resume',
    decisions?: HitlDecision[],
  ): Promise<void> {
    const { repo, emit } = this.deps;
    const abort = new AbortController();
    // 会话在开跑前被删掉就直接放弃
    const conv = repo.get(conversationId);
    if (!conv) return;
    const workspaceDir = conv.workspaceDir;
    const runtimeDir = this.runtimeDir(conversationId);
    const snapshots = this.deps.videoSnapshots;
    const files = this.deps.files;
    const runKey = randomUUID();
    const inner = new LocalWorkspaceSandbox(workspaceDir, {
      tracker: this.deps.processes,
      beforeWrite: snapshots ? (filePath) => snapshots.capture(conversationId, workspaceDir, filePath, runKey) : undefined,
      trackWrite: files ? (filePath) => files.begin(conversationId, resolve(workspaceDir, filePath)) : undefined,
    });
    this.active.set(conversationId, { abort, sandbox: inner });
    /** 本轮正常结束：收尾后补投运行期间结束的后台任务通知（同 backend worker 在 done 之后 deliverPending） */
    let deliverAfter = false;
    const persist = (raw: RawEvent) =>
      repo.appendMessage(conversationId, roleOf(raw.type), raw.type, raw.payload);
    // 画布（登录了 Web 账号才有）：本轮对画布的写入共用一个运行锁持有方，本轮结束统一释放；
    // 审批续跑接着用上一轮停下时留着的那个（锁一直在手里）
    const parked = this.parkedCanvas.get(conversationId);
    this.parkedCanvas.delete(conversationId);
    const canvasRun = this.deps.webApi ? (parked ?? this.canvasContext(conversationId, this.deps.webApi)) : null;
    /** 本轮停在审批上：画布锁留着给续跑 */
    let awaitingApproval = false;
    /** 本轮已经交给模型的插入消息 id（见 takeSteering） */
    const steered = new Set<string>();
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

      // ── 模型：会话所选的引用解析不了（连接已删 / 模型已停用）→ 账号默认模型 → 第一个启用的模型；
      // 换了就把会话改过去并在对话里提示一句。一个可用模型都没有：报错，界面引导去添加连接 ──
      const modelRef = this.deps.llm.effectiveRef(conv.model);
      if (!modelRef) throw new Error(hostI18n.t('errors.models.noneAvailable'));
      if (conv.model && modelRef !== conv.model) {
        repo.update(conversationId, { model: modelRef });
        const notice: RawEvent = {
          type: 'message',
          payload: {
            text: hostI18n.t('errors.models.fallback', {
              from: parseModelRef(conv.model)?.modelId ?? conv.model,
              to: parseModelRef(modelRef)?.modelId ?? modelRef,
            }),
          },
        };
        emit(conversationId, notice);
        persist(notice);
        this.deps.listChanged();
      }

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
        // 模式勾的子 agent（其它模式）；通用模式没有
        subagentModes: this.deps.modes.subagentModes(mode),
      });
      const skillNames = assembly.skills.map((s) => s.name);

      try {
        // 主 agent 与子 agent 勾的技能一起同步（共用一个技能库目录）
        await this.deps.skills.syncToRuntime(
          runtimeDir,
          mountableSkills(assembly).map((s) => s.name),
        );
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
        // 对话记忆只认 message 表：每轮开跑前清掉上一轮的 thread，checkpoint 只服务本轮内的审批续跑。
        // SqliteSaver 跑完一轮会完整保留 messages，不清的话重放的历史会再叠一份（见 core run/history.ts）
        await this.deps.checkpointer.deleteThread(conversationId);
        const history = await this.loadHistory(conversationId);
        // 按 token 预算压缩历史（参照 deepagents summarization 中间件）：超了就把早前部分摘要，
        // 摘要落成 context_summary 行，之后的轮次直接复用；摘要用本轮同一个模型
        const compacted = await compactHistory({
          history,
          model: (await this.deps.resolveModel(modelRef, null)).model,
          signal: abort.signal,
          onError: (e) => this.deps.log?.(`历史摘要失败，本轮只重放近期历史 conversation=${conversationId}: ${String(e)}`),
        });
        if (compacted.newSummary) {
          repo.appendMessage(conversationId, roleOf('context_summary'), 'context_summary', compacted.newSummary);
        }
        const userTexts = history.userTexts;
        const last = userTexts[userTexts.length - 1] ?? '';
        const cmd = parseCommand(last);
        runName = cmd ? `技能:${cmd.name} · ${cmd.args}`.slice(0, 60) : `Agent · ${last.slice(0, 60)}`;
        input = { messages: compacted.messages };
        // /技能名 不在当前模式技能集内：当普通文本（决策 15），不注入其 SKILL.md
        systemPromptExtra = await buildSkillPrompt(
          userTexts,
          (name) => (skillNames.includes(name) ? this.deps.skills.skillMd(name) : Promise.resolve(null)),
          skillsDir,
          // 上下文里已有那次完整的 read_file 结果（工具调用对会重放）就不再重复注入全文
          compacted.messages,
        );
      }
      const activePlan = buildActivePlan(repo.lastOfType(conversationId, 'plan_update')?.content);
      const { tools, interruptOn, subagents } = instantiateTools(
        assembly,
        {
          conversationId,
          userId: LOCAL_USER_ID,
          env,
          host: {
            workspaceDir,
            runtimeDir,
            permission: conv.permission,
            mcpServers: assembly.mcpServers,
            canvas: canvasRun,
          },
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
        model: modelRef,
        resolveModel: this.deps.resolveModel,
        thinkingLevel: asThinkingLevel(conv.thinkingLevel),
        checkpointer: this.deps.checkpointer,
        dynamicContext: [activePlanProvider, mcpAppContextProvider],
        subagents,
        // 画布状态注入：挂了画布工具、且对话绑定了画布时，画布一变就追加一份最新状态（与 Web 画布 agent 同一份逻辑）
        middleware: [
          ...(canvasRun && tools.some((t) => t.name === 'add_node')
            ? [createCanvasStateMiddleware(() => this.canvasContextText(canvasRun))]
            : []),
          // 运行中插入的用户消息：主 agent 每次模型调用前取走待插入的，写进对话（见 core run/steering.ts）
          createSteeringMiddleware(() => this.takeSteering(conversationId, steered)),
        ],
      });

      const stream = await agent.stream(input, {
        ...config,
        signal: abort.signal,
        runName,
        tags: ['spark-desktop', kind],
        metadata: { conversationId, kind },
        context: { activePlan, userId: LOCAL_USER_ID },
        // tasks：把子 agent 的 namespace 对应到发起它的 task 调用（见 core consume-stream）
        streamMode: [...AGENT_STREAM_MODES],
        subgraphs: true,
        // checkpoint 只在图退出（完成 / 出错 / 停在审批）时存一份：默认每一步都存一份完整状态（全部消息），
        // 步数多的一轮能写出几百 MB，而崩溃后本来就从 message 表重放，中间状态用不上
        durability: 'exit',
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
          steered: (id) => this.deliverSteered(conversationId, id),
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
          // provider 没回模型名时记账用的名字：引用里的模型 id（不带连接 id）
          fallbackModel: parseModelRef(modelRef)?.modelId ?? modelRef,
          signal: abort.signal,
        },
      );

      const interrupt = readInterrupt(await agent.getState(config));
      if (interrupt) {
        if (!repo.transition(conversationId, ['running'], 'waiting_approval')) {
          this.finalizeStopped(conversationId);
          return;
        }
        awaitingApproval = true;
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
      // checkpoint 只留给停在审批上的那一轮续跑：其余结局（完成 / 失败 / 停止）到这里就用不上了，立刻清掉
      if (!awaitingApproval) await this.deps.checkpointer.deleteThread(conversationId);
      // 释放本轮持有的画布运行锁；停在审批上时留给续跑（见 parkedCanvas）
      if (canvasRun && awaitingApproval) this.parkedCanvas.set(conversationId, canvasRun);
      else await canvasRun?.session.close();
      await inner.stop();
      this.deps.listChanged();
      // 会话现在空闲、且这一轮是正常结束的：没赶上插入的消息和排队的消息合并成新的一轮（后台任务通知并进去）；
      // 没有待发消息时，当时没投出去的后台任务通知写进会话并唤醒新一轮。被停止 / 失败的不自动续跑，待发消息留着
      if (deliverAfter && !this.continueWithPending(conversationId)) this.background?.deliverPending(conversationId);
    }
  }

  /** 本轮的画布上下文：当前画布取自对话的绑定（工具 open_canvas / create_canvas 或用户点开画布会改它） */
  private canvasContext(conversationId: string, webApi: WebApi): CanvasRunContext {
    const { repo } = this.deps;
    const web = new CanvasWeb(webApi);
    return {
      web,
      // 给其它端看的说明：对话标题，没起标题的新对话用它的目标（第一条消息）
      session: new CanvasRunSession(
        web,
        () => {
          const c = repo.get(conversationId);
          return c?.title || c?.goal.slice(0, 60) || null;
        },
        (m) => this.deps.log?.(m),
      ),
      conversationId,
      current: () => repo.get(conversationId)?.canvasId ?? null,
      bind: (canvasId) => {
        repo.setCanvas(conversationId, canvasId);
        this.deps.listChanged();
      },
    };
  }

  /** 放掉停在审批上的那一轮一直持有的画布锁（审批被停止 / 对话被删） */
  private async releaseParkedCanvas(conversationId: string): Promise<void> {
    const parked = this.parkedCanvas.get(conversationId);
    if (!parked) return;
    this.parkedCanvas.delete(conversationId);
    await parked.session.close();
  }

  /** 注入给模型的画布文本；没绑定画布或取不到（网络 / 画布已删）就不注入 */
  private async canvasContextText(ctx: CanvasRunContext): Promise<string | null> {
    const id = ctx.current();
    if (!id) return null;
    try {
      return await ctx.web.agentContext(id);
    } catch (e) {
      this.deps.log?.(`取画布状态失败 canvas=${id}: ${String(e)}`);
      return null;
    }
  }

  /** 停止收尾：补发并落库 result{stopped}（流式残余文本已由 consumeAgentStream 收口落库） */
  private finalizeStopped(conversationId: string): void {
    const { repo, emit } = this.deps;
    const evt: RawEvent = { type: 'result', payload: { status: 'stopped' } };
    emit(conversationId, evt);
    repo.appendMessage(conversationId, 'assistant', 'result', evt.payload);
  }

  /** 从 message 表取重放历史（工具调用配对、子 agent 事件、摘要切点的处理见 core historyFromRows） */
  private loadHistory(conversationId: string): Promise<ReplayHistory> {
    return historyFromRows(this.deps.repo.messages(conversationId), userTextForModel);
  }
}
