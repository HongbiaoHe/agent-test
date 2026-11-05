import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardedSandbox } from '@agent-test/agent-core/agent/guarded-sandbox';
import { Annotation, Command, interrupt, StateGraph } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteSaver } from './db/checkpointer';
import { ConversationRepo } from './db/conversations';
import { openDatabase } from './db/database';
import { copyAttachments, userTextForModel } from './run/attachments';
import { buildActivePlan } from './run/prompts';
import { SkillInstallError, SkillStore } from './skills/skill-store';
import { LocalWorkspaceSandbox, whitelistedEnv } from './workspace/local-sandbox';
import { listDir, readFilePreview, WorkspacePathError } from './workspace/files';
import { ProcessTracker } from './workspace/process-tracker';
import { buildWorkspaceBackend, permissionInterrupts } from './workspace/workspace-backend';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spark-desktop-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('NodeSqliteSaver', () => {
  /** 一个会在中途 interrupt 的最小图：模拟「等用户审批」 */
  function buildGraph(saver: NodeSqliteSaver) {
    const State = Annotation.Root({ log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }) });
    return new StateGraph(State)
      .addNode('ask', () => {
        const answer = interrupt<string, string>('approve?');
        return { log: [`answer:${answer}`] };
      })
      .addEdge('__start__', 'ask')
      .compile({ checkpointer: saver });
  }

  it('中断态落库，换一个 saver 实例（模拟重启应用）仍能续跑', async () => {
    const file = join(dir, 'spark.db');
    const config = { configurable: { thread_id: 't1' } };
    const first = buildGraph(new NodeSqliteSaver(openDatabase(file)));
    await first.invoke({ log: ['start'] }, config);
    const state = await first.getState(config);
    expect(state.tasks[0]?.interrupts[0]?.value).toBe('approve?');

    const second = buildGraph(new NodeSqliteSaver(openDatabase(file)));
    const out = await second.invoke(new Command({ resume: 'yes' }), config);
    expect(out.log).toEqual(['start', 'answer:yes']);
  });

  it('deleteThread 清掉该会话的 checkpoint', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const saver = new NodeSqliteSaver(db);
    const config = { configurable: { thread_id: 't2' } };
    await buildGraph(saver).invoke({ log: [] }, config);
    expect(await saver.getTuple(config)).toBeDefined();
    await saver.deleteThread('t2');
    expect(await saver.getTuple(config)).toBeUndefined();
  });
});

describe('LocalWorkspaceSandbox', () => {
  it('在工作区里执行，输出合并 stdout/stderr 并带退出码', async () => {
    const sb = new LocalWorkspaceSandbox(dir);
    const r = await sb.execute('pwd; echo err >&2; exit 3');
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('err');
    expect(r.output).toContain(dir.replace('/private', '').split('/').pop());
  });

  it('超时会杀掉整个进程组', async () => {
    const sb = new LocalWorkspaceSandbox(dir, { timeoutMs: 300 });
    const t0 = Date.now();
    const r = await sb.execute('sleep 5 & sleep 5; echo never');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.output).toContain('已终止');
    expect(r.output).not.toContain('never');
  });

  it('stop() 立即终止正在执行的命令（停止运行时用）', async () => {
    const sb = new LocalWorkspaceSandbox(dir);
    const pending = sb.execute('sleep 30');
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await sb.stop();
    const r = await pending;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.exitCode).not.toBe(0);
  });

  it('stop() 也能杀掉 GuardedSandbox 包装后子 shell 里的孙进程', async () => {
    const alive = () => {
      try {
        execFileSync('pgrep', ['-f', 'sleep 93']);
        return true;
      } catch {
        return false;
      }
    };
    const inner = new LocalWorkspaceSandbox(dir);
    const guarded = new GuardedSandbox(inner, dir, dir);
    const pending = guarded.execute('sleep 93 && echo late');
    await new Promise((r) => setTimeout(r, 300));
    expect(alive()).toBe(true);
    await inner.stop();
    await pending;
    await new Promise((r) => setTimeout(r, 200));
    expect(alive()).toBe(false);
  });

  it('子进程环境只含白名单变量（模型 Key 不会被命令打印出来）', async () => {
    const env = whitelistedEnv({ PATH: '/usr/bin', HOME: '/tmp', GOOGLE_API_KEY: 'secret-key' });
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    const sb = new LocalWorkspaceSandbox(dir, { env });
    const r = await sb.execute('env');
    expect(r.output).not.toContain('secret-key');
    expect(r.output).toContain('HOME=/tmp');
  });

  it('套上 GuardedSandbox 后：工作区内可读写，越界路径被拒绝', async () => {
    const guarded = new GuardedSandbox(new LocalWorkspaceSandbox(dir), dir, dir);
    const w = await guarded.write(`${dir}/a.txt`, 'hello');
    expect(w.error).toBeUndefined();
    const read = await guarded.read(`${dir}/a.txt`);
    expect(JSON.stringify(read)).toContain('hello');
    const escape = await guarded.write('/tmp/spark-escape.txt', 'x');
    expect(escape.error).toBeTruthy();
    expect(existsSync('/tmp/spark-escape.txt')).toBe(false);
    const ex = await guarded.execute('cat a.txt');
    expect(ex.output).toContain('hello');
  });
});

describe('ProcessTracker（崩溃后清理孤儿命令）', () => {
  const alive = (pattern: string) => {
    try {
      execFileSync('pgrep', ['-f', pattern]);
      return true;
    } catch {
      return false;
    }
  };

  it('模拟 agent-host 崩溃：没 stop 的命令进程组在下次启动时被清理', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const sb = new LocalWorkspaceSandbox(dir, { tracker: new ProcessTracker(db) });
    void new GuardedSandbox(sb, dir, dir).execute('sleep 87 && echo late');
    await new Promise((r) => setTimeout(r, 300));
    expect(alive('sleep 87')).toBe(true);
    // 「崩溃」：不调 stop()，换一个新进程视角（新连接 + 新 tracker）来收拾
    const reaped = new ProcessTracker(openDatabase(join(dir, 'spark.db'))).reapOrphans();
    expect(reaped).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive('sleep 87')).toBe(false);
  });

  it('pid 已被不相干的进程复用（命令行对不上）时不误杀', async () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const other = spawn('/bin/bash', ['-c', 'sleep 86'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    const tracker = new ProcessTracker(db);
    tracker.add(other.pid ?? -1, '/bin/bash -c 别的命令');
    expect(tracker.reapOrphans()).toBe(0);
    expect(alive('sleep 86')).toBe(true);
    process.kill(-(other.pid ?? 0), 'SIGKILL');
  });
});

describe('ConversationRepo', () => {
  it('启动时把 running 会话标为失败并追加「运行中断」', () => {
    const repo = new ConversationRepo(openDatabase(join(dir, 'spark.db')), () => dir);
    const c = repo.create(null);
    repo.setStatus(c.id, 'running');
    expect(repo.failInterrupted()).toEqual([c.id]);
    expect(repo.require(c.id).status).toBe('failed');
    const last = repo.messages(c.id).at(-1);
    expect(last?.type).toBe('error');
  });

  it('transition 是 CAS：状态不在 from 里就不改', () => {
    const repo = new ConversationRepo(openDatabase(join(dir, 'spark.db')), () => dir);
    const c = repo.create(null);
    expect(repo.transition(c.id, ['waiting_approval'], 'running')).toBe(false);
    repo.setStatus(c.id, 'waiting_approval');
    expect(repo.transition(c.id, ['waiting_approval'], 'running')).toBe(true);
  });

  it('同一条 AIMessage 的 token 只记一次', () => {
    const repo = new ConversationRepo(openDatabase(join(dir, 'spark.db')), () => dir);
    const c = repo.create(null);
    const u = { conversationId: c.id, turnMessageId: 'm', messageId: 'ai-1', model: 'x', input: 1, output: 2, total: 3, cacheRead: 0, cacheCreation: 0 };
    expect(repo.recordUsage(u)).toBe(true);
    expect(repo.recordUsage(u)).toBe(false);
    expect(repo.totalTokens(c.id)).toBe(3);
  });
});

describe('SkillStore', () => {
  async function makeSkill(name: string, description = 'demo skill') {
    const folder = join(dir, 'src', name);
    await mkdir(join(folder, 'references'), { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
    await writeFile(join(folder, 'references', 'a.md'), 'ref');
    return folder;
  }

  it('从文件夹安装，同步到工作区；停用后同步会删掉它', async () => {
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
    await store.installFromFolder(await makeSkill('alpha'));
    await store.installFromFolder(await makeSkill('beta'));
    const ws = join(dir, 'ws');
    expect(await store.syncToRuntime(ws)).toEqual(['alpha', 'beta']);
    expect(existsSync(join(ws, 'skills', 'alpha', 'references', 'a.md'))).toBe(true);
    await store.setEnabled('beta', false);
    await store.syncToRuntime(ws);
    expect(await readdir(join(ws, 'skills'))).toEqual(['alpha']);
    expect(await store.skillMd('beta')).toBeNull();
  });

  it('name 与目录名不一致时拒绝安装', async () => {
    const store = new SkillStore(openDatabase(join(dir, 'spark.db')), join(dir, 'lib'));
    const folder = await makeSkill('gamma');
    await writeFile(join(folder, 'SKILL.md'), '---\nname: other\ndescription: d\n---\n');
    await expect(store.installFromFolder(folder)).rejects.toBeInstanceOf(SkillInstallError);
  });
});

describe('附件与提示词', () => {
  it('复制进运行目录（重名自动加序号），副本被删后重放时标「已丢失」', async () => {
    const src = join(dir, 'note.txt');
    await writeFile(src, 'hi');
    const ws = join(dir, 'ws');
    const [a, b] = await copyAttachments(join(ws, 'attachments'), [src, src]);
    expect(a.path).toBe(join(ws, 'attachments', 'note.txt'));
    expect(b.filename).toBe('note (1).txt');
    expect(await userTextForModel({ text: '看看', attachments: [a] })).toContain(a.path);
    await rm(a.path);
    expect(await userTextForModel({ text: '看看', attachments: [a] })).toContain('附件已丢失');
  });

  it('activePlan 由最近一次 plan_update 生成，没有计划为空串', () => {
    expect(buildActivePlan(null)).toBe('');
    const text = buildActivePlan({ todos: [{ content: '写代码', status: 'in_progress' }] });
    expect(text).toContain('1. [in_progress] 写代码');
  });
});

describe('会话工作区与权限', () => {
  it('新会话记下自选目录与权限；没存过目录的旧会话跟随默认工作区', () => {
    const db = openDatabase(join(dir, 'spark.db'));
    const repo = new ConversationRepo(db, () => '/default/ws');
    const c = repo.create(null, { dir: '/my/project', permission: 'read_only' });
    expect(repo.require(c.id)).toMatchObject({ workspaceDir: '/my/project', permission: 'read_only' });
    db.prepare('UPDATE conversation SET workspace_dir = NULL WHERE id = ?').run(c.id);
    expect(repo.require(c.id).workspaceDir).toBe('/default/ws');
    expect(repo.setPermission(c.id, 'auto').permission).toBe('auto');
  });

  it('已经有消息的会话不能再换目录', () => {
    const repo = new ConversationRepo(openDatabase(join(dir, 'spark.db')), () => dir);
    const c = repo.create(null);
    expect(repo.setWorkspaceDir(c.id, '/other').workspaceDir).toBe('/other');
    repo.appendMessage(c.id, 'user', 'message', { text: 'hi' });
    expect(() => repo.setWorkspaceDir(c.id, '/again')).toThrow('不能再更换工作目录');
  });

  it('询问档位拦截写 / 改 / 执行（含后台命令）；自动与只读不进审批', () => {
    expect(permissionInterrupts('ask')).toEqual({
      execute: true,
      write_file: true,
      edit_file: true,
      run_in_background: true,
      sync_media_to_sandbox: true,
    });
    expect(permissionInterrupts('auto')).toEqual({});
    expect(permissionInterrupts('read_only')).toEqual({});
  });

  it('只读档位：工作区能读，写与执行被拒；运行目录始终只读，但 execute 能按绝对路径用它', async () => {
    const ws = join(dir, 'ws');
    const runtime = join(dir, 'runtime');
    await mkdir(join(runtime, 'skills', 'demo'), { recursive: true });
    await writeFile(join(runtime, 'skills', 'demo', 'SKILL.md'), 'skill-body');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'a.txt'), 'hello');

    const ro = buildWorkspaceBackend({
      inner: new LocalWorkspaceSandbox(ws),
      workspaceDir: ws,
      runtimeDir: runtime,
      permission: 'read_only',
    });
    expect(JSON.stringify(await ro.backend.read(join(ws, 'a.txt')))).toContain('hello');
    expect((await ro.backend.write(join(ws, 'b.txt'), 'x')).error).toBeTruthy();
    expect(existsSync(join(ws, 'b.txt'))).toBe(false);
    expect((await ro.backend.execute('touch c.txt')).exitCode).toBe(1);
    expect(existsSync(join(ws, 'c.txt'))).toBe(false);
    expect(ro.skillsDir).toBe(join(runtime, 'skills'));

    const auto = buildWorkspaceBackend({
      inner: new LocalWorkspaceSandbox(ws),
      workspaceDir: ws,
      runtimeDir: runtime,
      permission: 'auto',
    });
    const skillPath = join(runtime, 'skills', 'demo', 'SKILL.md');
    expect(JSON.stringify(await auto.backend.read(skillPath))).toContain('skill-body');
    expect((await auto.backend.write(join(runtime, 'skills', 'x.md'), 'x')).error).toBeTruthy();
    expect((await auto.backend.execute(`cat '${skillPath}'`)).output).toContain('skill-body');
    expect((await auto.backend.write(join(ws, 'b.txt'), 'ok')).error).toBeUndefined();
    expect(await readFile(join(ws, 'b.txt'), 'utf8')).toBe('ok');
  });
});

describe('工作区文件面板', () => {
  it('列目录：隐藏点文件与 node_modules，目录在前；路径为工作区相对路径', async () => {
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await writeFile(join(dir, '.env'), 'SECRET=1');
    await writeFile(join(dir, 'b.txt'), 'b');
    await writeFile(join(dir, 'src', 'a.ts'), 'a');
    const root = await listDir(dir, '');
    expect(root.map((e) => e.name)).toEqual(['src', 'b.txt']);
    expect((await listDir(dir, 'src')).map((e) => e.path)).toEqual(['src/deep', 'src/a.ts']);
  });

  it('不能经 ../ 或软链读到工作区外', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'spark-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'top-secret');
    await symlink(outside, join(dir, 'link'));
    await expect(readFilePreview(dir, '../' + outside.split('/').pop() + '/secret.txt')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(readFilePreview(dir, 'link/secret.txt')).rejects.toBeInstanceOf(WorkspacePathError);
    await rm(outside, { recursive: true, force: true });
  });

  it('预览：文本原文、图片 dataUrl、其它二进制只给大小', async () => {
    await writeFile(join(dir, 'n.md'), '# hi');
    await writeFile(join(dir, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, 'z.bin'), Buffer.alloc(10));
    expect(await readFilePreview(dir, 'n.md')).toEqual({ kind: 'text', content: '# hi', truncated: false });
    expect(await readFilePreview(dir, 'p.png')).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(await readFilePreview(dir, 'z.bin')).toEqual({ kind: 'binary', size: 10 });
  });
});

describe('token 报表', () => {
  it('按轮归组（最新在前），三层合计自洽，轮目标取触发它的用户消息', () => {
    const repo = new ConversationRepo(openDatabase(join(dir, 'spark.db')), () => dir);
    const c = repo.create(null);
    const m1 = repo.appendMessage(c.id, 'user', 'message', { text: '第一轮' });
    const m2 = repo.appendMessage(c.id, 'user', 'message', { text: '第二轮' });
    const base = { conversationId: c.id, cacheRead: 0, cacheCreation: 0 };
    repo.recordUsage({ ...base, turnMessageId: m1.id, messageId: 'a', model: 'g', input: 10, output: 5, total: 20 });
    repo.recordUsage({ ...base, turnMessageId: m2.id, messageId: 'b', model: 'g', input: 1, output: 1, total: 2 });
    repo.recordUsage({ ...base, turnMessageId: m2.id, messageId: 'c', model: 'd', input: 3, output: 3, total: 6 });
    const r = repo.tokenReport(c.id);
    expect(r.totals.total).toBe(28);
    expect(r.totals.calls).toBe(3);
    expect(r.runs.map((x) => x.goal)).toEqual(['第二轮', '第一轮']);
    expect(r.runs[0].byModel.map((x) => x.model).sort()).toEqual(['d', 'g']);
    expect(r.runs[1].totals.reasoning).toBe(5);
  });
});
