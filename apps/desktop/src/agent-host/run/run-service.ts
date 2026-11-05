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
import { isBaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { buildAgent, type BuiltAgent } from '@agent-test/agent-core/agent/agent.factory';
import {
  extractThinkingBlocks,
  normalize,
  type RawEvent,
} from '@agent-test/agent-core/agent/event-normalizer';
import { resolveModelName } from '@agent-test/agent-core/agent/models';
import { ReasoningCollector } from '@agent-test/agent-core/agent/reasoning-parts';
import { asThinkingLevel } from '@agent-test/agent-core/agent/thinking-level';
import { type CallUsage, extractUsages } from '@agent-test/agent-core/agent/token-usage';
import { parseCommand } from '@agent-test/agent-core/commands/parse-command';
import {
  buildMcpAgentTools,
  buildMcpPrompt,
} from '@agent-test/agent-core/mcp/mcp-agent-tools';
import { z } from 'zod';
import type { HitlDecision } from '../../shared/rpc';
import type { NodeSqliteSaver } from '../db/checkpointer';
import type { ConversationRepo } from '../db/conversations';
import type { McpStore } from '../mcp/mcp-store';
import type { BackgroundService } from '../background/background-service';
import { backgroundPrompt, createBackgroundTools } from '../background/background-tools';
import { parseSkillSource, skillsAddArgs } from '../skills/github-install';
import type { WebApi } from '../web-media/web-api';
import { createSyncMediaTool, createWebMediaTools, uploadAttachment } from '../web-media/web-media';
import { createSaveSkillTool, SAVE_SKILL_TOOL } from '../skills/save-skill.tool';
import type { SkillStore } from '../skills/skill-store';
import { LocalWorkspaceSandbox } from '../workspace/local-sandbox';
import type { ProcessTracker } from '../workspace/process-tracker';
import { buildWorkspaceBackend, permissionInterrupts } from '../workspace/workspace-backend';
import { copyAttachments, userTextForModel } from './attachments';
import {
  buildActivePlan,
  buildSkillPrompt,
  DESKTOP_HOST_SECTIONS,
  DESKTOP_MEDIA_SECTIONS,
  localWorkspaceBlock,
} from './prompts';

/** 桌面端单用户：contextSchema 要求 userId 必填，固定传这个值 */
export const LOCAL_USER_ID = 'local';
const MAX_HISTORY = 200;

const ROLE_BY_TYPE: Record<string, string> = {
  message: 'assistant',
  result: 'assistant',
  plan_update: 'assistant',
  tool_start: 'assistant',
  tool_end: 'tool',
  control_request: 'assistant',
  reasoning: 'assistant',
  error: 'assistant',
};

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

type HistoryMessage = { role: string; content: string; tool_call_id?: string };

const textPayload = z.object({ text: z.string().optional() });
const toolEndPayload = z.object({ name: z.string().optional(), content: z.unknown() });
const interruptState = z.object({
  tasks: z
    .array(z.object({ interrupts: z.array(z.object({ value: z.unknown() })).optional() }))
    .optional(),
});
const interruptValue = z.object({
  actionRequests: z.array(z.object({ name: z.string().optional() })).optional(),
});
const stateMessages = z.object({
  values: z.object({ messages: z.array(z.unknown()).optional() }).optional(),
});

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
      throw new BusyError('这个会话正在运行，请先等它结束或点停止');
    }
    if (!text.trim() && attachmentPaths.length === 0) throw new Error('消息不能为空');
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
        `已安装 ${installed.length} 个技能：\n\n` +
          installed.map((s) => `- \`/${s.name}\` — ${s.description}`).join('\n') +
          `\n\n输入 \`/技能名 需求\` 即可使用。`,
      );
    } catch (e) {
      say(`安装失败：${e instanceof Error ? e.message : String(e)}`);
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
      throw new BusyError('当前没有待审批的操作');
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
    if (changed) this.finalizeStopped(conversationId, '');
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
    let buf = '';
    /** 本轮正常结束：收尾后补投运行期间结束的后台任务通知（同 backend worker 在 done 之后 deliverPending） */
    let deliverAfter = false;
    const persist = (raw: RawEvent) =>
      repo.appendMessage(conversationId, ROLE_BY_TYPE[raw.type] ?? 'assistant', raw.type, raw.payload);
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

      try {
        await this.deps.skills.syncToRuntime(runtimeDir);
      } catch (e) {
        emit(conversationId, {
          type: 'message',
          payload: { text: `⚠️ 技能同步到工作区失败，本轮不使用技能：${String(e)}` },
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
        systemPromptExtra = await buildSkillPrompt(
          userTexts,
          (name) => this.deps.skills.skillMd(name),
          skillsDir,
        );
      }
      const activePlan = buildActivePlan(repo.lastOfType(conversationId, 'plan_update')?.content);
      const servers = this.deps.mcp.runtimeServers();
      const webApi = this.deps.webApi;
      const mediaTools = webApi
        ? [
            ...createWebMediaTools(webApi, conversationId),
            ...(conv.permission === 'read_only' ? [] : [createSyncMediaTool(webApi, conversationId, workspaceDir)]),
          ]
        : [];
      const bgTools = this.background
        ? createBackgroundTools(this.background, {
            conversationId,
            workspaceDir,
            logDir: join(runtimeDir, 'bg'),
            permission: conv.permission,
            mcpServers: servers,
          })
        : [];
      const mcp = buildMcpAgentTools(servers, (sid, name, args) =>
        this.deps.mcp.callTool(sid, name, args),
      );

      const agent = await buildAgent({
        checkpointer: this.deps.checkpointer,
        hostPromptSections: DESKTOP_HOST_SECTIONS + (webApi ? DESKTOP_MEDIA_SECTIONS : ''),
        workspacePromptBlock: localWorkspaceBlock({ skillsDir, permission: conv.permission }),
        systemPromptExtra:
          systemPromptExtra +
          buildMcpPrompt(servers, this.deps.mcp.appContext(conversationId)) +
          (this.background ? backgroundPrompt(conv.permission !== 'read_only') : ''),
        extraInterruptOn: {
          ...mcp.interruptOn,
          ...permissionInterrupts(conv.permission),
          // 保存技能会改变之后所有对话的行为：任何权限档位都要用户确认
          [SAVE_SKILL_TOOL]: true,
        },
        model: conv.model ?? cfg.defaultModel,
        thinkingLevel: asThinkingLevel(conv.thinkingLevel),
        defaultBackend: backend,
        hasSandbox: true,
        workspace: workspaceDir,
        skillsDir,
        extraTools: [
          ...mcp.tools,
          createSaveSkillTool(this.deps.skills, () => this.deps.skillsChanged?.()),
          ...bgTools,
          ...mediaTools,
        ],
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

      const reasoning = new ReasoningCollector(await this.priorMessageIds(agent, config));
      const flushReasoning = () => {
        for (const part of reasoning.drain()) persist({ type: 'reasoning', payload: part });
      };
      const pushReasoning = (part: { sourceId: string; text: string } | null) => {
        if (part) emit(conversationId, { type: 'reasoning', payload: part });
      };
      const flush = (override?: string) => {
        const text = override ?? buf;
        buf = '';
        if (!text) return;
        const msg: RawEvent = { type: 'message', payload: { text } };
        emit(conversationId, msg);
        persist(msg);
      };
      const turnMessageId = repo.lastUserMessageId(conversationId) ?? conversationId;
      const seen = repo.usageMessageIds(conversationId);
      let total = repo.totalTokens(conversationId);
      const modelName = resolveModelName(conv.model ?? cfg.defaultModel);
      const recordUsage = (call: CallUsage) => {
        const ok = repo.recordUsage({ conversationId, turnMessageId, ...call });
        if (!ok) return;
        total += call.total;
        emit(conversationId, {
          type: 'token_usage',
          payload: { ...call, cumulativeTotal: total },
        });
      };

      for await (const chunk of stream) {
        const [ns, mode, data] = z
          .tuple([z.array(z.string()), z.string(), z.unknown()])
          .parse(chunk);
        if (mode === 'updates') {
          for (const call of extractUsages(data, seen, modelName)) recordUsage(call);
          for (const part of extractThinkingBlocks(data)) {
            pushReasoning(reasoning.takeBlock(part.id, part.text));
          }
        }
        const raw = normalize(ns, mode, data);
        if (!raw) continue;
        if (raw.type === 'reasoning') {
          const p = z.object({ text: z.string(), sourceId: z.string() }).parse(raw.payload);
          pushReasoning(reasoning.appendDelta(p.sourceId, p.text));
          continue;
        }
        flushReasoning();
        if (raw.type === 'token') {
          buf += textPayload.parse(raw.payload).text ?? '';
          emit(conversationId, raw);
          continue;
        }
        if (raw.type === 'message') {
          flush(buf || (textPayload.parse(raw.payload).text ?? ''));
          continue;
        }
        flush();
        emit(conversationId, raw);
        persist(raw);
      }
      flushReasoning();
      flush();

      const state = interruptState.safeParse(await agent.getState(config));
      const interrupts = state.success
        ? (state.data.tasks ?? []).flatMap((t) => t.interrupts ?? [])
        : [];
      if (interrupts.length > 0) {
        if (!repo.transition(conversationId, ['running'], 'waiting_approval')) {
          this.finalizeStopped(conversationId, '');
          return;
        }
        const evt: RawEvent = { type: 'control_request', payload: interrupts[0].value };
        emit(conversationId, evt);
        persist(evt);
        const toolName = interruptValue.safeParse(interrupts[0].value).data?.actionRequests?.[0]?.name;
        this.deps.log?.(`conversation=${conversationId} 等待审批 ${toolName ?? ''}`);
        return;
      }
      if (!repo.transition(conversationId, ['running'], 'done')) {
        this.finalizeStopped(conversationId, '');
        return;
      }
      const resultEvt: RawEvent = { type: 'result', payload: { status: 'done' } };
      emit(conversationId, resultEvt);
      persist(resultEvt);
      deliverAfter = true;
    } catch (e) {
      if (abort.signal.aborted) {
        this.finalizeStopped(conversationId, buf);
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

  /** 停止收尾：保留已累积的流式文本，补发并落库 result{stopped} */
  private finalizeStopped(conversationId: string, leftover: string): void {
    const { repo, emit } = this.deps;
    if (leftover) {
      const msg: RawEvent = { type: 'message', payload: { text: leftover } };
      emit(conversationId, msg);
      repo.appendMessage(conversationId, 'assistant', 'message', msg.payload);
    }
    const evt: RawEvent = { type: 'result', payload: { status: 'stopped' } };
    emit(conversationId, evt);
    repo.appendMessage(conversationId, 'assistant', 'result', evt.payload);
  }

  /** run 开始前 checkpoint 里已有的消息 id（审批续跑时 updates 会整批回放它们，其思考已落过库） */
  private async priorMessageIds(agent: BuiltAgent, config: unknown): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const parsed = stateMessages.safeParse(await agent.getState(config));
      for (const m of parsed.data?.values?.messages ?? []) {
        if (isBaseMessage(m) && m.id) ids.add(m.id);
      }
    } catch {
      this.deps.log?.('priorMessageIds 读取 checkpoint 失败，本轮不排除历史思考');
    }
    return ids;
  }

  /**
   * 从 message 表重放完整对话历史（user / assistant 文本 + tool_end 结果），取最近 200 条且以 user 开头。
   * tool_call_id 是合成值（库里不存原始 id），只为满足 ToolMessage 结构（同 backend loadHistory）。
   */
  private async loadHistory(conversationId: string): Promise<HistoryMessage[]> {
    const rows = this.deps.repo
      .messages(conversationId)
      .filter(
        (m) =>
          (m.type === 'message' || m.type === 'tool_end') &&
          (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'),
      );
    let slice = rows.length > MAX_HISTORY ? rows.slice(-MAX_HISTORY) : rows;
    while (slice.length > 0 && slice[0].role !== 'user') slice = slice.slice(1);
    const out: HistoryMessage[] = [];
    for (const m of slice) {
      if (m.type === 'tool_end') {
        const p = toolEndPayload.safeParse(m.content);
        const content = p.success ? p.data.content : '';
        out.push({
          role: 'tool',
          content: typeof content === 'string' ? content : JSON.stringify(content),
          tool_call_id: `synth_${(p.success && p.data.name) || 'tool'}_${m.seq}`,
        });
        continue;
      }
      out.push({
        role: m.role,
        content:
          m.role === 'user'
            ? await userTextForModel(m.content)
            : (textPayload.safeParse(m.content).data?.text ?? ''),
      });
    }
    return out;
  }
}
