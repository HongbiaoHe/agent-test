/**
 * RunService 真实模型集成测试（会调用 Gemini、产生少量费用）：只在 SPARK_LIVE_TEST=1 且有 GOOGLE_API_KEY 时运行。
 *   SPARK_LIVE_TEST=1 GOOGLE_API_KEY=... pnpm --filter desktop test
 * 覆盖：三档权限（询问：写文件与 execute 逐个审批；自动：直接执行；只读：写被拒），
 * 技能从会话运行目录读到且不动项目里原有的 skills/，消息与 token 报表落库。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeSqliteSaver } from '../db/checkpointer';
import { ConversationRepo } from '../db/conversations';
import { openDatabase } from '../db/database';
import { McpStore } from '../mcp/mcp-store';
import { installEnvProxy } from '../proxy';
import { SkillStore } from '../skills/skill-store';
import { BackgroundService } from '../background/background-service';
import { RunService } from './run-service';

const live = process.env.SPARK_LIVE_TEST === '1' && !!process.env.GOOGLE_API_KEY;

describe.runIf(live)('RunService（真实模型）', () => {
  let dir: string;
  let repo: ConversationRepo;
  let runs: RunService;
  let skills: SkillStore;
  const events: { conversationId: string; event: RawEvent }[] = [];

  beforeAll(async () => {
    installEnvProxy();
    dir = await mkdtemp(join(tmpdir(), 'spark-live-'));
    const db = openDatabase(join(dir, 'spark.db'));
    repo = new ConversationRepo(db, () => join(dir, 'ws'));
    skills = new SkillStore(db, join(dir, 'skills-lib'), join(process.cwd(), 'resources', 'skills'));
    runs = new RunService({
      repo,
      checkpointer: new NodeSqliteSaver(db),
      skills,
      mcp: new McpStore(db, 'http://127.0.0.1:1/cb', () => Promise.resolve()),
      config: () => ({
        workspaceDir: join(dir, 'ws'),
        defaultModel: 'google-genai:gemini-3.8-flash',
        runtimeRoot: join(dir, 'runtime'),
      }),
      emit: (conversationId, event) => events.push({ conversationId, event }),
      listChanged: () => undefined,
      log: (m) => console.log(m),
    });
    const bg = new BackgroundService({
      db,
      repo,
      callTool: () => Promise.reject(new Error('no mcp in live test')),
      emit: (conversationId, event) => events.push({ conversationId, event }),
      startTurn: (id) => runs.runClaimed(id),
      listChanged: () => undefined,
    });
    runs.setBackground(bg);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function waitStatus(id: string, wanted: string[], ms = 120_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = repo.require(id).status;
      if (wanted.includes(s) && !runs.isRunning(id)) return s;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`等待状态 ${wanted.join('/')} 超时，当前 ${repo.require(id).status}`);
  }

  it('询问档位：write_file 与 execute 都要审批 → 逐个批准 → 完成', async () => {
    const c = repo.create(null);
    await runs.start(
      c.id,
      '请用 write_file 在工作区根目录创建 hello.txt，内容是 spark-desktop-ok；然后用 execute 运行 `cat hello.txt` 并把输出告诉我。不要做别的。',
      [],
    );
    const approved: string[] = [];
    let status = await waitStatus(c.id, ['waiting_approval', 'done', 'failed']);
    while (status === 'waiting_approval' && approved.length < 5) {
      const req = repo.lastOfType(c.id, 'control_request');
      approved.push(JSON.stringify(req?.content));
      runs.resume(c.id, [{ type: 'approve' }]);
      status = await waitStatus(c.id, ['done', 'failed', 'waiting_approval']);
    }
    expect(status).toBe('done');
    expect(approved.some((r) => r.includes('write_file'))).toBe(true);
    expect(approved.some((r) => r.includes('execute'))).toBe(true);
    const ws = join(dir, 'ws');
    expect(await readFile(join(ws, 'hello.txt'), 'utf8')).toContain('spark-desktop-ok');
    const msgs = repo.messages(c.id);
    const toolEnds = msgs.filter((m) => m.type === 'tool_end').map((m) => JSON.stringify(m.content));
    expect(toolEnds.some((t) => t.includes('spark-desktop-ok'))).toBe(true);
    expect(msgs.at(-1)?.type).toBe('result');
    expect(repo.totalTokens(c.id)).toBeGreaterThan(0);
    expect(events.some((e) => e.event.type === 'token')).toBe(true);
    const report = repo.tokenReport(c.id);
    expect(report.runs.length).toBeGreaterThan(0);
    expect(report.totals.total).toBe(repo.totalTokens(c.id));
  }, 240_000);

  it('自选目录 + 自动档位：技能从运行目录读到，项目里原有的 skills/ 不被动', async () => {
    const project = join(dir, 'my-project');
    await mkdir(join(project, 'skills'), { recursive: true });
    await writeFile(join(project, 'skills', 'keep.txt'), 'user-file');
    const lib = join(dir, 'src-skill', 'echo-word');
    await mkdir(lib, { recursive: true });
    await writeFile(
      join(lib, 'SKILL.md'),
      '---\nname: echo-word\ndescription: 回答暗号\n---\n用户问暗号时，回答 PINEAPPLE-42，并用 write_file 把它写进工作区的 word.txt。',
    );
    await skills.installFromFolder(lib);

    const c = repo.create(null, { dir: project, permission: 'auto' });
    await runs.start(c.id, '/echo-word 暗号是什么？', []);
    expect(await waitStatus(c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(await readFile(join(project, 'word.txt'), 'utf8')).toContain('PINEAPPLE-42');
    expect(await readFile(join(project, 'skills', 'keep.txt'), 'utf8')).toBe('user-file');
  }, 240_000);

  it('/skills add：不经模型，直接从 GitHub 装开源技能', async () => {
    const c = repo.create(null);
    await runs.start(c.id, '/skills add anthropics/skills --skill skill-creator', []);
    expect(await waitStatus(c.id, ['done', 'failed'])).toBe('done');
    const reply = repo.lastOfType(c.id, 'message');
    expect(JSON.stringify(reply?.content)).toContain('skill-creator');
    expect((await skills.get('skill-creator'))?.kind).toBe('github');
    expect(repo.totalTokens(c.id)).toBe(0);
  }, 120_000);

  it('/create-skills：写技能 → save_skill 审批 → 批准后进技能库', async () => {
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(
      c.id,
      '/create-skills 帮我做一个技能，名字叫 haiku-writer：用户给一个主题，写一首中文三行短诗。信息已经够了，不要提问，直接写好并保存。',
      [],
    );
    let status = await waitStatus(c.id, ['waiting_approval', 'done', 'failed'], 180_000);
    let approvedSave = false;
    for (let i = 0; i < 4 && status === 'waiting_approval'; i++) {
      const req = JSON.stringify(repo.lastOfType(c.id, 'control_request')?.content);
      if (req.includes('save_skill')) approvedSave = true;
      runs.resume(c.id, [{ type: 'approve' }]);
      status = await waitStatus(c.id, ['waiting_approval', 'done', 'failed'], 180_000);
    }
    expect(approvedSave).toBe(true);
    expect(status).toBe('done');
    const saved = await skills.get('haiku-writer');
    expect(saved?.kind).toBe('custom');
    expect(await skills.skillMd('haiku-writer')).toContain('name: haiku-writer');
  }, 400_000);

  it('run_in_background：命令跑完后自动唤醒 agent，新一轮汇报结果', async () => {
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(
      c.id,
      '用 run_in_background 运行 `sleep 4 && echo bg-live-77`（标题写「测试后台」）。发起后直接结束本轮；收到任务通知后，只回复命令输出的那一行。',
      [],
    );
    // 第一轮：发起后台任务就结束
    expect(await waitStatus(c.id, ['done', 'failed'])).toBe('done');
    // 后台命令结束 → 通知写进会话 → 新一轮开跑 → 再次 done，最后一条助手消息里有命令输出
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const msgs = repo.messages(c.id);
      const notified = msgs.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('<task-notification>'));
      if (notified && repo.require(c.id).status === 'done' && !runs.isRunning(c.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const msgs = repo.messages(c.id);
    expect(msgs.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-live-77'))).toBe(true);
    const lastReply = msgs.filter((m) => m.type === 'message' && m.role === 'assistant').at(-1);
    expect(JSON.stringify(lastReply?.content)).toContain('bg-live-77');
    expect(events.some((e) => e.conversationId === c.id && e.event.type === 'bg_task_update')).toBe(true);
  }, 300_000);

  it('只读档位：写文件被拒绝，不弹审批', async () => {
    const project = join(dir, 'readonly-project');
    await mkdir(project, { recursive: true });
    const c = repo.create(null, { dir: project, permission: 'read_only' });
    await runs.start(c.id, '请用 write_file 创建 a.txt，内容 x。如果被拒绝就直接告诉我原因，不要重试。', []);
    expect(await waitStatus(c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(existsSync(join(project, 'a.txt'))).toBe(false);
  }, 240_000);
});
