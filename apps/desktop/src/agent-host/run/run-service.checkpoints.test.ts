/**
 * RunService 的 checkpoint 生命周期（假模型，不联网）：
 * checkpoint 只服务「停在审批上的那一轮」的续跑——只在图退出时存一份，一轮结束（完成 / 失败 / 停止）就清掉，
 * 库里不留用不上的中间状态（对话记忆在 message 表，见 run-service.ts）。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { AIMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NodeSqliteSaver } from '../db/checkpointer';
import { ConversationRepo } from '../db/conversations';
import { type Db, openDatabase } from '../db/database';
import { LlmStore } from '../llm/llm-store';
import { McpStore } from '../mcp/mcp-store';
import { ModeStore } from '../modes/mode-store';
import { SkillStore } from '../skills/skill-store';
import { ConversationFiles } from '../storage/conversation-files';
import { RunService } from './run-service';
import { buildDesktopRegistry } from './tool-registry';

type FakeModel = ReturnType<typeof fakeModel>;

let dir: string;
let db: Db;
let repo: ConversationRepo;
let events: RawEvent[];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'spark-ckpt-')));
  db = openDatabase(join(dir, 'spark.db'));
  repo = new ConversationRepo(db, () => join(dir, 'ws'));
  events = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function buildRuns(model: FakeModel): RunService {
  const llm = new LlmStore(db, () => 'test-key');
  const conn = llm.createConnection({ name: 'Fake', protocol: 'gemini', baseUrl: 'https://example.invalid', presetId: 'gemini' });
  llm.addManualModel(conn.id, 'fake-model');
  llm.setDefaultModel(`${conn.id}/fake-model`);
  const skills = new SkillStore(db, join(dir, 'skills-lib'));
  return new RunService({
    repo,
    checkpointer: new NodeSqliteSaver(db),
    skills,
    mcp: new McpStore(db, 'http://127.0.0.1:1/cb', () => Promise.resolve()),
    modes: new ModeStore(db),
    registry: buildDesktopRegistry({ webApi: null, skills, skillsChanged: () => undefined, background: () => null }),
    config: () => ({ workspaceDir: join(dir, 'ws'), runtimeRoot: join(dir, 'runtime') }),
    llm,
    resolveModel: () => Promise.resolve({ model, keepsNativeBlocks: false }),
    emit: (_id, event) => events.push(event),
    listChanged: () => undefined,
    files: new ConversationFiles(db),
  });
}

const countRow = z.object({ n: z.number() });
/** 该会话在库里的 checkpoint 行数 / 待写入行数 */
function stored(threadId: string): { checkpoints: number; writes: number } {
  const count = (table: 'checkpoints' | 'writes') =>
    countRow.parse(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`).get(threadId)).n;
  return { checkpoints: count('checkpoints'), writes: count('writes') };
}

async function waitStatus(runs: RunService, id: string, wanted: string[], ms = 20_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = repo.require(id).status;
    if (wanted.includes(s) && !runs.isRunning(id)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  const errors = repo.messages(id).filter((m) => m.type === 'error').map((m) => JSON.stringify(m.content));
  throw new Error(`等待状态 ${wanted.join('/')} 超时，当前 ${repo.require(id).status} ${errors.join(' ')}`);
}

const writeHello = { name: 'write_file', args: { file_path: 'hello.txt', content: 'ckpt-ok' }, id: 'w1' };

describe('RunService checkpoint 生命周期', () => {
  it('自动档位：多步跑完后，库里不留这个会话的 checkpoint', async () => {
    const runs = buildRuns(fakeModel().respondWithTools([writeHello]).respond(new AIMessage('写好了')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '写 hello.txt', []);
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');
    expect(await readFile(join(dir, 'ws', 'hello.txt'), 'utf8')).toBe('ckpt-ok');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('询问档位：停在审批时只存退出那一份；批准后续跑完成，随即清空', async () => {
    const runs = buildRuns(fakeModel().respondWithTools([writeHello]).respond(new AIMessage('写好了')));
    const c = repo.create(null, { permission: 'ask' });
    await runs.start(c.id, '写 hello.txt', []);
    expect(await waitStatus(runs, c.id, ['waiting_approval', 'done', 'failed'])).toBe('waiting_approval');
    expect(existsSync(join(dir, 'ws', 'hello.txt'))).toBe(false);
    // 中间步骤不落库：只有图退出（中断）时的一份
    expect(stored(c.id).checkpoints).toBe(1);

    runs.resume(c.id, [{ type: 'approve' }]);
    expect(await waitStatus(runs, c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(await readFile(join(dir, 'ws', 'hello.txt'), 'utf8')).toBe('ckpt-ok');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('等审批时重启应用（换一套 RunService / saver 实例）仍能批准续跑', async () => {
    const first = buildRuns(fakeModel().respondWithTools([writeHello]));
    const c = repo.create(null, { permission: 'ask' });
    await first.start(c.id, '写 hello.txt', []);
    expect(await waitStatus(first, c.id, ['waiting_approval', 'done', 'failed'])).toBe('waiting_approval');

    const second = buildRuns(fakeModel().respond(new AIMessage('写好了')));
    second.resume(c.id, [{ type: 'approve' }]);
    expect(await waitStatus(second, c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(await readFile(join(dir, 'ws', 'hello.txt'), 'utf8')).toBe('ckpt-ok');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('等审批时点停止：那次中断不会再续跑，checkpoint 一并清掉', async () => {
    const runs = buildRuns(fakeModel().respondWithTools([writeHello]));
    const c = repo.create(null, { permission: 'ask' });
    await runs.start(c.id, '写 hello.txt', []);
    expect(await waitStatus(runs, c.id, ['waiting_approval', 'done', 'failed'])).toBe('waiting_approval');
    runs.stop(c.id);
    expect(repo.require(c.id).status).toBe('stopped');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('模型报错（本轮失败）后同样不留 checkpoint', async () => {
    const runs = buildRuns(fakeModel().respondWithTools([writeHello]).respond(new Error('boom')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '写 hello.txt', []);
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('failed');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });

  it('子 agent 里的工具停在审批：批准后子 agent 续跑完成，主 agent 收尾，随即清空', async () => {
    // 主 agent 与子 agent 共用一个假模型，回复按调用顺序出队：主派任务 → 子写文件（审批）→ 子收尾 → 主收尾
    const model = fakeModel()
      .respondWithTools([
        { name: 'task', args: { description: '用 write_file 写 hello.txt', subagent_type: 'general-purpose' }, id: 't1' },
      ])
      .respondWithTools([writeHello])
      .respond(new AIMessage('子任务完成'))
      .respond(new AIMessage('写好了'));
    const runs = buildRuns(model);
    const c = repo.create(null, { permission: 'ask' });
    await runs.start(c.id, '让子 agent 写 hello.txt', []);
    expect(await waitStatus(runs, c.id, ['waiting_approval', 'done', 'failed'])).toBe('waiting_approval');
    expect(existsSync(join(dir, 'ws', 'hello.txt'))).toBe(false);
    expect(JSON.stringify(repo.lastOfType(c.id, 'control_request')?.content)).toContain('write_file');

    runs.resume(c.id, [{ type: 'approve' }]);
    expect(await waitStatus(runs, c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(await readFile(join(dir, 'ws', 'hello.txt'), 'utf8')).toBe('ckpt-ok');
    const texts = repo.messages(c.id).filter((m) => m.type === 'message').map((m) => JSON.stringify(m.content));
    expect(texts.at(-1)).toContain('写好了');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });
});

describe('RunService 与删会话', () => {
  it('agent 用 write_file 新建的文件记在这个会话名下；改已有文件不算', async () => {
    await mkdir(join(dir, 'ws'), { recursive: true });
    await writeFile(join(dir, 'ws', 'existing.txt'), 'user file');
    const model = fakeModel()
      .respondWithTools([
        writeHello,
        { name: 'edit_file', args: { file_path: 'existing.txt', old_string: 'user', new_string: 'agent' }, id: 'e1' },
      ])
      .respond(new AIMessage('好了'));
    const runs = buildRuns(model);
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '写文件', []);
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');
    expect(await readFile(join(dir, 'ws', 'existing.txt'), 'utf8')).toBe('agent file');
    expect(new ConversationFiles(db).owned(c.id)).toEqual([join(dir, 'ws', 'hello.txt')]);
  });

  it('edit_file 改一个不存在的文件（失败）不记：之后用户在那个路径建的文件不归这个会话', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'edit_file', args: { file_path: 'missing.txt', old_string: 'a', new_string: 'b' }, id: 'e1' }])
      .respond(new AIMessage('文件不存在'));
    const runs = buildRuns(model);
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '改 missing.txt', []);
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');
    expect(existsSync(join(dir, 'ws', 'missing.txt'))).toBe(false);
    await writeFile(join(dir, 'ws', 'missing.txt'), 'user created later');
    expect(new ConversationFiles(db).owned(c.id)).toEqual([]);
  });

  it('stopAndWait：运行中停止并等收尾落库完成，之后删会话不会再有东西往里写', async () => {
    const model = fakeModel().respondWithTools([{ name: 'execute', args: { command: 'sleep 30' }, id: 'x1' }]);
    const runs = buildRuns(model);
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '跑个慢命令', []);
    await vi.waitFor(() => expect(repo.messages(c.id).some((m) => m.type === 'tool_start')).toBe(true), { timeout: 10_000 });
    expect(runs.isRunning(c.id)).toBe(true);

    await runs.stopAndWait(c.id);

    // 收尾已完成：不再运行，stopped 结果已落库，checkpoint 已清
    expect(runs.isRunning(c.id)).toBe(false);
    expect(repo.require(c.id).status).toBe('stopped');
    expect(repo.messages(c.id).at(-1)?.type).toBe('result');
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
    // 现在删会话，等一会儿也不会有收尾再写进来（没有外键错误、没有残留行）
    repo.delete(c.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(stored(c.id)).toEqual({ checkpoints: 0, writes: 0 });
  });
});
