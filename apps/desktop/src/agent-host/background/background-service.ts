/**
 * 会话后台任务（desktop 版 BackgroundService，逐项对照 apps/backend/src/background/background.service.ts）：
 * 创建 / 推进 / 结束 / 取消 / 结束后以 <task-notification> 唤醒 agent。
 *
 * 与 backend 的差异只在运行时：
 * - 没有 Redis / BullMQ：agent-host 进程内 setTimeout 推进，下一次推进时刻写进 next_tick_at，
 *   agent-host 重启（改 Key、崩溃）后 resume() 按它恢复——watch / wakeup 照常继续；
 * - 后台命令由 agent-host 直接起独立进程组（不经 shell 脚本与 .bg 状态文件），用进程的 exit 事件结束任务，
 *   日志写在会话运行目录（agent 只读可达，不往用户工作区里写）；命令进程组登记进 ProcessTracker，
 *   agent-host 意外退出后由下次启动清理，对应任务标为中断并通知 agent。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { resultToModelText } from '@agent-test/agent-core/mcp/mcp-result';
import { McpAuthRequiredError } from '@agent-test/agent-core/mcp/mcp-types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BackgroundKind, BackgroundStatus, BackgroundTaskView } from '../../shared/rpc';
import type { ConversationRepo } from '../db/conversations';
import { type Db, transaction } from '../db/database';
import { whitelistedEnv } from '../workspace/local-sandbox';
import type { ProcessTracker } from '../workspace/process-tracker';
import { LIMITS, type TaskResult, truncate, wakeupSpecSchema, type WatchSpec, watchSpecSchema } from './background-types';
import { evaluateWatch } from './watch-condition';

/** 只有这几种会话状态可以被后台通知直接唤醒；运行中 / 等审批的等本轮结束再投递，停止了的不唤醒（同 backend） */
const WAKEABLE = ['idle', 'done', 'failed'] as const;

const KINDS = ['watch', 'command', 'wakeup'] as const;
const STATUSES = ['running', 'succeeded', 'failed', 'timeout', 'cancelled'] as const;

const taskRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  kind: z.enum(KINDS),
  title: z.string(),
  status: z.enum(STATUSES),
  spec: z.string(),
  result: z.string().nullable(),
  polls: z.number(),
  notify: z.number(),
  delivered: z.number(),
  deadline_at: z.number(),
  next_tick_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  created_at: z.number(),
});
type TaskRow = z.infer<typeof taskRow>;

const resultSchema = z.object({
  text: z.string(),
  value: z.string().optional(),
  exitCode: z.number().optional(),
});

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resultOf(row: TaskRow): TaskResult | null {
  const r = resultSchema.safeParse(parseJson(row.result));
  return r.success ? r.data : null;
}

export function toView(row: TaskRow): BackgroundTaskView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    result: resultOf(row),
    polls: row.polls,
    deadlineAt: new Date(row.deadline_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** 通知正文：给模型看，XML 包裹，明确是系统生成的而非用户发言（同 backend notificationText） */
export function notificationText(row: TaskRow, result: TaskResult): string {
  return [
    '<task-notification>',
    `<task-id>${row.id}</task-id>`,
    `<kind>${row.kind}</kind>`,
    `<status>${row.status}</status>`,
    `<title>${row.title}</title>`,
    `<result>\n${result.text}\n</result>`,
    '</task-notification>',
  ].join('\n');
}

export interface BackgroundDeps {
  db: Db;
  repo: ConversationRepo;
  /** 调 MCP 工具（watch 轮询用，同 McpStore.callTool） */
  callTool: (serverId: string, name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  processes?: ProcessTracker;
  emit: (conversationId: string, event: RawEvent) => void;
  /** 通知已写进会话、会话已 CAS 置为 running：开跑下一轮（RunService.runClaimed） */
  startTurn: (conversationId: string) => void;
  listChanged: () => void;
  log?: (msg: string) => void;
  /** 测试用：缩短各种时长 */
  now?: () => number;
}

export class BackgroundService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly now: () => number;

  constructor(private readonly deps: BackgroundDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── 创建 ─────────────────────────────────────────────────────────────────

  assertCapacity(conversationId: string): void {
    const r = this.deps.db
      .prepare("SELECT COUNT(*) AS n FROM background_task WHERE conversation_id = ? AND status = 'running'")
      .get(conversationId);
    const active = z.object({ n: z.number() }).parse(r).n;
    if (active >= LIMITS.maxActivePerConversation) {
      throw new Error(
        `This conversation already has ${active} background tasks running (max ${LIMITS.maxActivePerConversation}). Wait for one to finish or cancel one.`,
      );
    }
  }

  create(input: {
    conversationId: string;
    kind: Exclude<BackgroundKind, 'command'>;
    title: string;
    spec: object;
    timeoutMin: number;
    notify: boolean;
    firstTickMs: number;
  }): BackgroundTaskView {
    const id = randomUUID().replace(/-/g, '');
    const now = this.now();
    this.deps.db
      .prepare(
        `INSERT INTO background_task (id, conversation_id, kind, title, spec, notify, deadline_at, next_tick_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.kind,
        input.title.slice(0, 200),
        JSON.stringify(input.spec),
        input.notify ? 1 : 0,
        now + input.timeoutMin * 60_000,
        now + input.firstTickMs,
        now,
      );
    const row = this.row(id);
    this.publish(row);
    this.schedule(id, input.firstTickMs);
    return toView(row);
  }

  /**
   * 后台命令：独立进程组（detached，可整组杀）、白名单环境变量、输出写日志文件；
   * 进程退出即结束任务，到 deadline 未退出就整组杀掉判超时。
   */
  async startCommand(input: {
    conversationId: string;
    title: string;
    command: string;
    cwd: string;
    logDir: string;
    timeoutMin: number;
    notify: boolean;
  }): Promise<BackgroundTaskView> {
    const id = randomUUID().replace(/-/g, '');
    const now = this.now();
    const logPath = join(input.logDir, id, 'out.log');
    await mkdir(join(input.logDir, id), { recursive: true });
    this.deps.db
      .prepare(
        `INSERT INTO background_task (id, conversation_id, kind, title, spec, notify, deadline_at, created_at)
         VALUES (?, ?, 'command', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.title.slice(0, 200),
        JSON.stringify({ command: input.command, cwd: input.cwd, logPath }),
        input.notify ? 1 : 0,
        now + input.timeoutMin * 60_000,
        now,
      );
    const out = createWriteStream(logPath);
    const child = spawn('/bin/bash', ['-c', input.command], {
      cwd: input.cwd,
      env: whitelistedEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    const pid = child.pid;
    if (pid !== undefined) this.deps.processes?.add(pid, `/bin/bash -c ${input.command}`);
    this.children.set(id, child);
    let spawnError: Error | null = null;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.on('close', (code, signal) => {
      out.end();
      this.children.delete(id);
      if (pid !== undefined) this.deps.processes?.remove(pid);
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      void this.onCommandExit(id, logPath, code, signal, spawnError);
    });
    // deadline：整组杀掉判超时（close 事件里 status 已是 timeout，不会再覆盖）
    this.timers.set(
      id,
      setTimeout(() => {
        const row = this.row(id);
        this.finish(row, 'timeout', { text: `Timed out after ${input.timeoutMin} minutes; the command was killed.` });
        killGroup(child);
      }, input.timeoutMin * 60_000),
    );
    const row = this.row(id);
    this.publish(row);
    return toView(row);
  }

  private async onCommandExit(
    id: string,
    logPath: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError: Error | null,
  ): Promise<void> {
    const row = this.row(id);
    if (row.status !== 'running') return; // 已被取消 / 超时
    const tail = await tailOf(logPath, 4000);
    if (spawnError) {
      this.finish(row, 'failed', { text: `Failed to start: ${spawnError.message}` });
      return;
    }
    const exitCode = code ?? (signal ? 128 : 1);
    this.finish(row, exitCode === 0 ? 'succeeded' : 'failed', {
      text: truncate(`Exit code ${exitCode}${signal ? ` (${signal})` : ''}. Output tail (full log: ${logPath}):\n${tail}`),
      exitCode,
    });
  }

  // ── 推进（watch / wakeup）─────────────────────────────────────────────────

  private schedule(id: string, delayMs: number): void {
    const prev = this.timers.get(id);
    if (prev) clearTimeout(prev);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.tick(id).catch((e: unknown) => this.failUnexpected(id, e));
      }, Math.max(0, delayMs)),
    );
  }

  async tick(id: string): Promise<void> {
    const row = this.maybeRow(id);
    if (!row || row.status !== 'running') return;
    if (row.kind === 'wakeup') {
      const spec = wakeupSpecSchema.parse(parseJson(row.spec));
      this.finish(row, 'succeeded', { text: `Scheduled wakeup fired. Your note: ${spec.note}` });
      return;
    }
    if (row.kind !== 'watch') return;
    if (this.now() >= row.deadline_at) {
      this.finish(row, 'timeout', {
        text: `Timed out after ${row.polls} checks without reaching the expected state.`,
      });
      return;
    }
    const polls = row.polls + 1;
    const spec = watchSpecSchema.parse(parseJson(row.spec));
    try {
      const result = await this.deps.callTool(spec.serverId, spec.toolName, spec.args);
      const { outcome, value } = evaluateWatch(result, spec.untilPath, spec.doneValues, spec.failValues);
      if (outcome !== 'pending') {
        this.finish({ ...row, polls }, outcome === 'done' ? 'succeeded' : 'failed', {
          text: truncate(resultToModelText(result)),
          value,
        });
        return;
      }
      this.continueWith(row, polls, { ...spec, consecutiveErrors: 0 });
    } catch (e) {
      if (e instanceof McpAuthRequiredError) {
        this.finish({ ...row, polls }, 'failed', {
          text: `${e.serverName} needs to be reconnected; polling stopped.`,
        });
        return;
      }
      const errors = spec.consecutiveErrors + 1;
      this.deps.log?.(`watch ${row.id} 第 ${polls} 次轮询失败（连续 ${errors}）：${String(e)}`);
      if (errors >= LIMITS.maxConsecutiveErrors) {
        this.finish({ ...row, polls }, 'failed', {
          text: `Polling ${spec.modelToolName} failed ${errors} times in a row: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }
      this.continueWith(row, polls, { ...spec, consecutiveErrors: errors });
    }
  }

  private continueWith(row: TaskRow, polls: number, spec: WatchSpec): void {
    const delay = spec.intervalSec * 1000;
    this.deps.db
      .prepare('UPDATE background_task SET polls = ?, spec = ?, next_tick_at = ? WHERE id = ? AND status = ?')
      .run(polls, JSON.stringify(spec), this.now() + delay, row.id, 'running');
    this.publish(this.row(row.id));
    this.schedule(row.id, delay);
  }

  // ── 结束 / 取消 ───────────────────────────────────────────────────────────

  /** CAS 结束：只有仍在 running 的任务能被结束，保证结束通知恰好一份（同 backend） */
  private finish(row: TaskRow, status: Exclude<BackgroundStatus, 'running'>, result: TaskResult): void {
    const res = this.deps.db
      .prepare(
        `UPDATE background_task SET status = ?, result = ?, polls = ?, finished_at = ?, next_tick_at = NULL,
         delivered = ? WHERE id = ? AND status = 'running'`,
      )
      .run(
        status,
        JSON.stringify(result),
        row.polls,
        this.now(),
        // 取消的任务不通知（是用户 / agent 主动停的）
        status === 'cancelled' || row.notify === 0 ? 1 : 0,
        row.id,
      );
    if (Number(res.changes) === 0) return;
    const timer = this.timers.get(row.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(row.id);
    this.publish(this.row(row.id));
    if (status !== 'cancelled' && row.notify === 1) this.deliverPending(row.conversation_id);
  }

  private failUnexpected(id: string, error: unknown): void {
    const row = this.maybeRow(id);
    if (!row) return;
    this.finish(row, 'failed', {
      text: `Background task crashed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  cancel(taskId: string): BackgroundTaskView {
    const row = this.row(taskId);
    if (row.status === 'running') {
      this.finish(row, 'cancelled', { text: 'Cancelled.' });
      const child = this.children.get(taskId);
      if (child) killGroup(child);
    }
    return toView(this.row(taskId));
  }

  /** 用户停止会话 / 删除会话：一并取消该会话所有在跑的后台任务（同 backend：停止 = 停止所有操作） */
  cancelByConversation(conversationId: string): void {
    for (const row of this.rows(conversationId).filter((r) => r.status === 'running')) {
      this.finish(row, 'cancelled', { text: 'Cancelled (conversation stopped).' });
      const child = this.children.get(row.id);
      if (child) killGroup(child);
    }
  }

  list(conversationId: string): BackgroundTaskView[] {
    return this.rows(conversationId).map(toView);
  }

  /**
   * agent-host 启动时恢复：watch / wakeup 按 next_tick_at 继续；上次没跑完的后台命令（进程组已由
   * ProcessTracker.reapOrphans 清掉）标为失败并通知；再把会话空闲时没投出去的通知补投一遍。
   */
  resume(): void {
    const running = this.deps.db
      .prepare("SELECT * FROM background_task WHERE status = 'running'")
      .all()
      .map((r) => taskRow.parse(r));
    for (const row of running) {
      if (row.kind === 'command') {
        this.finish(row, 'failed', {
          text: 'The background command was interrupted because Spark restarted (the agent process exited). Re-run it if it is still needed.',
        });
        continue;
      }
      this.schedule(row.id, (row.next_tick_at ?? this.now()) - this.now());
    }
    const pending = this.deps.db
      .prepare("SELECT DISTINCT conversation_id FROM background_task WHERE delivered = 0 AND notify = 1 AND status != 'running'")
      .all()
      .map((r) => z.object({ conversation_id: z.string() }).parse(r).conversation_id);
    for (const id of pending) this.deliverPending(id);
  }

  /** agent-host 退出前：停掉计时器（后台命令进程组随后由 ProcessTracker 在下次启动时清理） */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── 通知投递 ─────────────────────────────────────────────────────────────

  /**
   * 把已结束、未投递的通知写进会话并唤醒 agent（同 backend deliverPending）：
   * 会话正忙时什么都不做——RunService 在这一轮结束后会再调一次。CAS 把会话置成 running 成功的那一方负责
   * 写消息与开跑，并发调用也只唤醒一次。
   */
  deliverPending(conversationId: string): void {
    const pending = this.deps.db
      .prepare(
        `SELECT * FROM background_task WHERE conversation_id = ? AND delivered = 0 AND notify = 1
         AND status != 'running' ORDER BY finished_at ASC`,
      )
      .all(conversationId)
      .map((r) => taskRow.parse(r));
    if (pending.length === 0) return;
    if (!this.deps.repo.get(conversationId)) return;
    if (!this.deps.repo.transition(conversationId, WAKEABLE, 'running')) return;
    transaction(this.deps.db, () => {
      for (const row of pending) {
        this.deps.db.prepare('UPDATE background_task SET delivered = 1 WHERE id = ?').run(row.id);
        const content = {
          text: notificationText(row, resultOf(row) ?? { text: '' }),
          notification: { taskId: row.id, kind: row.kind, title: row.title, status: row.status },
        };
        this.deps.repo.appendMessage(conversationId, 'user', 'message', content);
        this.deps.emit(conversationId, { type: 'task_notification', payload: content });
      }
    });
    this.deps.listChanged();
    this.deps.log?.(`会话 ${conversationId} 投递 ${pending.length} 条后台任务通知并唤醒 agent`);
    this.deps.startTurn(conversationId);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private rows(conversationId: string): TaskRow[] {
    return this.deps.db
      .prepare('SELECT * FROM background_task WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId)
      .map((r) => taskRow.parse(r));
  }

  private maybeRow(id: string): TaskRow | null {
    const r = this.deps.db.prepare('SELECT * FROM background_task WHERE id = ?').get(id);
    return r ? taskRow.parse(r) : null;
  }

  private row(id: string): TaskRow {
    const r = this.maybeRow(id);
    if (!r) throw new Error(`后台任务不存在：${id}`);
    return r;
  }

  private publish(row: TaskRow): void {
    this.deps.emit(row.conversation_id, { type: 'bg_task_update', payload: toView(row) });
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // 已经退出
  }
}

async function tailOf(path: string, bytes: number): Promise<string> {
  try {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}
