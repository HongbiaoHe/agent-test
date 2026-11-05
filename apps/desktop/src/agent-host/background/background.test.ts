import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import type { RuntimeServer } from '@agent-test/agent-core/mcp/mcp-types';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../db/conversations';
import { type Db, openDatabase } from '../db/database';
import { ProcessTracker } from '../workspace/process-tracker';
import { BackgroundService } from './background-service';
import { createBackgroundTools } from './background-tools';

let dir: string;
let db: Db;
let repo: ConversationRepo;
let events: { id: string; e: RawEvent }[];
let turns: string[];
let calls: (() => CallToolResult)[];

function service(extra: Partial<ConstructorParameters<typeof BackgroundService>[0]> = {}) {
  return new BackgroundService({
    db,
    repo,
    callTool: () => {
      const next = calls.shift();
      if (!next) throw new Error('no more calls');
      return Promise.resolve(next());
    },
    processes: new ProcessTracker(db),
    emit: (id, e) => events.push({ id, e }),
    startTurn: (id) => turns.push(id),
    listChanged: () => undefined,
    ...extra,
  });
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });

async function waitFor(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function alive(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern]);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-bg-'));
  db = openDatabase(join(dir, 'spark.db'));
  repo = new ConversationRepo(db, () => dir);
  events = [];
  turns = [];
  calls = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('后台命令', () => {
  it('跑完后结束任务、日志在运行目录；会话空闲时写入通知并唤醒新一轮', async () => {
    const conv = repo.create(null);
    repo.setStatus(conv.id, 'done');
    const bg = service();
    const view = await bg.startCommand({
      conversationId: conv.id,
      title: 'echo',
      command: 'echo bg-out-1; echo bg-err-2 >&2; exit 3',
      cwd: dir,
      logDir: join(dir, 'runtime', 'bg'),
      timeoutMin: 1,
      notify: true,
    });
    await waitFor(() => turns.length === 1);
    const done = bg.list(conv.id)[0];
    expect(done.status).toBe('failed');
    expect(done.result?.exitCode).toBe(3);
    expect(done.result?.text).toContain('bg-out-1');
    expect(await readFile(join(dir, 'runtime', 'bg', view.id, 'out.log'), 'utf8')).toContain('bg-err-2');
    expect(repo.require(conv.id).status).toBe('running');
    const note = repo.messages(conv.id).at(-1);
    expect(note?.role).toBe('user');
    expect(JSON.stringify(note?.content)).toContain('<task-notification>');
    expect(events.map((x) => x.e.type)).toEqual(expect.arrayContaining(['bg_task_update', 'task_notification']));
  });

  it('取消：整组杀掉、不通知', async () => {
    const conv = repo.create(null);
    repo.setStatus(conv.id, 'done');
    const bg = service();
    const view = await bg.startCommand({
      conversationId: conv.id,
      title: 'long',
      command: 'sleep 81 && echo late',
      cwd: dir,
      logDir: join(dir, 'bg'),
      timeoutMin: 5,
      notify: true,
    });
    await waitFor(() => alive('sleep 81'));
    expect(bg.cancel(view.id).status).toBe('cancelled');
    await waitFor(() => !alive('sleep 81'));
    await new Promise((r) => setTimeout(r, 100));
    expect(turns).toEqual([]);
    expect(repo.messages(conv.id)).toHaveLength(0);
  });
});

describe('watch_until', () => {
  function watchSpec() {
    return {
      serverId: 's1',
      serverName: 'S',
      toolName: 'get_task',
      modelToolName: 's__get_task',
      args: { id: '1' },
      untilPath: 'status',
      doneValues: ['completed'],
      failValues: ['failed'],
      intervalSec: 5,
      consecutiveErrors: 0,
    };
  }

  it('轮询到目标值就结束，结果文本与命中值给模型；会话忙时先不投递，空闲后补投', async () => {
    const conv = repo.create(null);
    repo.setStatus(conv.id, 'running');
    const bg = service();
    calls.push(() => text('{"status":"running"}'), () => text('{"status":"completed","url":"x.png"}'));
    const view = bg.create({
      conversationId: conv.id,
      kind: 'watch',
      title: 'wait',
      spec: watchSpec(),
      timeoutMin: 30,
      notify: true,
      firstTickMs: 60_000,
    });
    await bg.tick(view.id);
    expect(bg.list(conv.id)[0]).toMatchObject({ status: 'running', polls: 1 });
    await bg.tick(view.id);
    const done = bg.list(conv.id)[0];
    expect(done).toMatchObject({ status: 'succeeded', polls: 2 });
    expect(done.result).toMatchObject({ value: 'completed' });
    expect(done.result?.text).toContain('x.png');
    expect(turns).toEqual([]); // 会话还在 running：不打断
    repo.setStatus(conv.id, 'done');
    bg.deliverPending(conv.id);
    expect(turns).toEqual([conv.id]);
    bg.deliverPending(conv.id); // 已投递：不重复
    expect(turns).toEqual([conv.id]);
    bg.dispose();
  });

  it('连续出错 3 次判失败', async () => {
    const conv = repo.create(null);
    const bg = service();
    const view = bg.create({
      conversationId: conv.id,
      kind: 'watch',
      title: 'wait',
      spec: watchSpec(),
      timeoutMin: 30,
      notify: false,
      firstTickMs: 60_000,
    });
    for (let i = 0; i < 3; i++) await bg.tick(view.id);
    expect(bg.list(conv.id)[0].status).toBe('failed');
    expect(bg.list(conv.id)[0].result?.text).toContain('failed 3 times');
    bg.dispose();
  });
});

describe('恢复、上限与工具', () => {
  it('重启恢复：没跑完的命令标中断并通知，wakeup 按原定时刻继续', () => {
    const conv = repo.create(null);
    repo.setStatus(conv.id, 'done');
    const now = Date.now();
    db.prepare(
      `INSERT INTO background_task (id, conversation_id, kind, title, spec, deadline_at, created_at)
       VALUES ('cmd1', ?, 'command', 'build', '{}', ?, ?)`,
    ).run(conv.id, now + 60_000, now);
    db.prepare(
      `INSERT INTO background_task (id, conversation_id, kind, title, spec, deadline_at, next_tick_at, created_at)
       VALUES ('wk1', ?, 'wakeup', 'later', '{"note":"n"}', ?, ?, ?)`,
    ).run(conv.id, now + 600_000, now + 600_000, now);
    const bg = service();
    bg.resume();
    const byId = Object.fromEntries(bg.list(conv.id).map((t) => [t.id, t]));
    expect(byId.cmd1.status).toBe('failed');
    expect(byId.cmd1.result?.text).toContain('interrupted');
    expect(byId.wk1.status).toBe('running');
    expect(turns).toEqual([conv.id]);
    bg.dispose();
  });

  it('每个会话最多 5 个进行中的任务', () => {
    const conv = repo.create(null);
    const bg = service();
    for (let i = 0; i < 5; i++) {
      bg.create({
        conversationId: conv.id,
        kind: 'wakeup',
        title: `w${i}`,
        spec: { note: 'n' },
        timeoutMin: 10,
        notify: true,
        firstTickMs: 600_000,
      });
    }
    expect(() => bg.assertCapacity(conv.id)).toThrow('max 5');
    bg.dispose();
  });

  it('工具：只读会话不提供后台命令；watch 只放行「始终允许」的工具', async () => {
    const conv = repo.create(null);
    const bg = service();
    const server: RuntimeServer = {
      id: 's1',
      slug: 's',
      name: 'S',
      instructions: null,
      permissions: {},
      tools: [
        {
          name: 'get_task',
          description: '',
          inputSchema: {},
          modelSchema: {},
          readOnly: true,
          destructive: false,
          visibility: ['model', 'app'],
        },
        {
          name: 'make',
          description: '',
          inputSchema: {},
          modelSchema: {},
          readOnly: false,
          destructive: false,
          visibility: ['model'],
        },
      ],
    };
    const ctx = { conversationId: conv.id, workspaceDir: dir, logDir: join(dir, 'bg'), mcpServers: [server] };
    const names = (p: 'read_only' | 'ask') => createBackgroundTools(bg, { ...ctx, permission: p }).map((t) => t.name);
    expect(names('read_only')).not.toContain('run_in_background');
    expect(names('ask')).toContain('run_in_background');
    const watch = createBackgroundTools(bg, { ...ctx, permission: 'ask' }).find((t) => t.name === 'watch_until');
    const args = { title: 't', arguments_json: '{}', until_path: 'status', done_values: ['ok'] };
    const denied: unknown = await watch?.invoke({ ...args, tool: 's__make' });
    expect(String(denied)).toContain('requires approval');
    const ok: unknown = await watch?.invoke({ ...args, tool: 's__get_task' });
    expect(String(ok)).toContain('taskId');
    bg.dispose();
  });
});
