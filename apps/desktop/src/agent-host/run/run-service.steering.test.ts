/**
 * 运行中插入 / 排队消息（假模型，不联网）。假模型按调用顺序出队，并记下每次调用收到的消息——
 * 断言的就是「模型在第几次调用看到了什么、顺序如何」，以及落库顺序与之后重放历史是否一致（前缀缓存的前提）。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { historyFromRows } from '@agent-test/agent-core/run/history';
import { STEERING_NOTE, steeringText } from '@agent-test/agent-core/run/steering';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { fakeModel } from '@langchain/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteSaver } from '../db/checkpointer';
import { ConversationRepo } from '../db/conversations';
import { type Db, openDatabase } from '../db/database';
import { LlmStore } from '../llm/llm-store';
import { McpStore } from '../mcp/mcp-store';
import { ModeStore } from '../modes/mode-store';
import { PendingStore } from '../pending/pending-store';
import { SkillStore } from '../skills/skill-store';
import { userTextForModel } from './attachments';
import { RunService } from './run-service';
import { buildDesktopRegistry } from './tool-registry';

type FakeModel = ReturnType<typeof fakeModel>;
type Reply = AIMessage | ((messages: BaseMessage[]) => AIMessage);

let dir: string;
let db: Db;
let repo: ConversationRepo;
let events: RawEvent[];
let pendingChanges: number;
/** 每次模型调用收到的消息（类型:正文），按调用顺序 */
let calls: string[][];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'spark-steer-')));
  db = openDatabase(join(dir, 'spark.db'));
  repo = new ConversationRepo(db, () => join(dir, 'ws'));
  events = [];
  pendingChanges = 0;
  calls = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 记下收到的消息再回复；只看用户 / 助手 / 工具三类（系统提示每次都一样，不比） */
function scripted(...replies: Reply[]): FakeModel {
  let model = fakeModel();
  for (const reply of replies) {
    model = model.respond((messages) => {
      calls.push(messages.filter((m) => m.getType() !== 'system').map((m) => `${m.getType()}:${m.text}`));
      return typeof reply === 'function' ? reply(messages) : reply;
    });
  }
  return model;
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }] });
/** 一条要跑一会儿的命令：给测试留出「工具执行期间发消息」的窗口 */
const slowCommand = (id: string) => toolCall('execute', { command: 'sleep 0.4 && echo slow-done' }, id);

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
    pending: new PendingStore(db),
    pendingChanged: () => {
      pendingChanges++;
    },
  });
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

/** 等到某个工具开始执行（tool_start 已落库） */
const toolStarted = (id: string, n = 1) =>
  vi.waitFor(() => expect(repo.messages(id).filter((m) => m.type === 'tool_start')).toHaveLength(n), { timeout: 10_000 });
const resultCount = (id: string) => repo.messages(id).filter((m) => m.type === 'result').length;
/** message 表里的行：角色/类型 + 用户消息正文 */
const rowsOf = (id: string) =>
  repo.messages(id).map((m) => {
    const c = m.content as { text?: string; injected?: boolean };
    return m.role === 'user' ? `user${c.injected ? '(injected)' : ''}:${c.text ?? ''}` : m.type;
  });

describe('运行中插入消息（steer）', () => {
  it('工具执行期间发来的两条消息：等工具跑完，在下一次模型调用前一起插入；落库顺序相同；之后每次调用前缀不变', async () => {
    const runs = buildRuns(scripted(slowCommand('x1'), toolCall('execute', { command: 'echo second' }, 'x2'), new AIMessage('都办好了')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '跑个慢命令', []);
    await toolStarted(c.id);
    await runs.enqueue(c.id, '改成用中文', [], 'steer');
    await runs.enqueue(c.id, '再加一个标题', [], 'steer');
    expect(runs.listPending(c.id).map((p) => `${p.kind}:${p.text}`)).toEqual(['steer:改成用中文', 'steer:再加一个标题']);
    // 还没送达：对话里没有这两条
    expect(rowsOf(c.id).filter((r) => r.startsWith('user'))).toEqual(['user:跑个慢命令']);

    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');

    // 只有 3 次模型调用（两条插入的消息没有各占一次）
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['human:跑个慢命令']);
    expect(calls[1].slice(0, 2)).toEqual(['human:跑个慢命令', 'ai:']);
    expect(calls[1][2]).toContain('slow-done'); // 工具没有被打断，结果完整
    expect(calls[1].slice(3)).toEqual([`human:${steeringText('改成用中文')}`, `human:${steeringText('再加一个标题')}`]);
    // 第 3 次调用：前缀与第 2 次逐条相同，插入的消息留在原位
    expect(calls[2].slice(0, calls[1].length)).toEqual(calls[1]);

    // 落库：插入的两条排在第一个工具结果之后、第二次工具调用之前；待发列表已清空
    expect(rowsOf(c.id)).toEqual([
      'user:跑个慢命令',
      'tool_start',
      'tool_end',
      'user(injected):改成用中文',
      'user(injected):再加一个标题',
      'tool_start',
      'tool_end',
      'message',
      'result',
    ]);
    expect(runs.listPending(c.id)).toEqual([]);
    expect(pendingChanges).toBeGreaterThanOrEqual(4);
    // 推给界面的用户消息是原文（不带给模型的那句说明），带 injected 标记
    const pushed = events.filter((e) => e.type === 'user_message').map((e) => e.payload as { text: string; injected?: boolean });
    expect(pushed.map((p) => `${p.text}:${String(p.injected)}`)).toEqual(['改成用中文:true', '再加一个标题:true']);
    expect(JSON.stringify(pushed)).not.toContain(STEERING_NOTE);

    // 下一轮重放历史：这段对话给模型的内容与当时实时看到的逐条一致（跨轮的前缀也稳定）
    const replay = await historyFromRows(repo.messages(c.id), userTextForModel);
    expect(replay.entries.map((e) => `${e.message.getType()}:${e.message.text}`).slice(0, calls[2].length)).toEqual(calls[2]);
  });

  it('没赶上插入（这一轮已经没有下一次模型调用）：这一轮结束后自动接着跑一轮，当普通用户消息', async () => {
    let runs: RunService | null = null;
    let convId = '';
    const model = scripted(
      // 最后一次模型调用进行中才发来消息
      () => {
        void runs?.enqueue(convId, '顺便把日志也清一下', [], 'steer');
        return new AIMessage('第一件事办完了');
      },
      new AIMessage('日志也清了'),
    );
    runs = buildRuns(model);
    const c = repo.create(null, { permission: 'auto' });
    convId = c.id;
    await runs.start(c.id, '办第一件事', []);
    await vi.waitFor(() => expect(resultCount(c.id)).toBe(2), { timeout: 10_000 });
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');

    expect(calls).toHaveLength(2);
    // 新的一轮里它是普通的用户消息：不带插入说明、没有 injected 标记
    expect(calls[1]).toEqual(['human:办第一件事', 'ai:第一件事办完了', 'human:顺便把日志也清一下']);
    expect(rowsOf(c.id)).toEqual(['user:办第一件事', 'message', 'result', 'user:顺便把日志也清一下', 'message', 'result']);
    expect(runs.listPending(c.id)).toEqual([]);
  });

  it('等审批时发来的消息先挂着，审批不被放弃；批准后在下一次模型调用前插入', async () => {
    const runs = buildRuns(scripted(toolCall('write_file', { file_path: 'a.txt', content: 'A' }, 'w1'), new AIMessage('写好了')));
    const c = repo.create(null, { permission: 'ask' });
    await runs.start(c.id, '写 a.txt', []);
    expect(await waitStatus(runs, c.id, ['waiting_approval', 'done', 'failed'])).toBe('waiting_approval');

    await runs.enqueue(c.id, '写完再告诉我路径', [], 'steer');
    expect(repo.require(c.id).status).toBe('waiting_approval');
    expect(runs.listPending(c.id).map((p) => p.text)).toEqual(['写完再告诉我路径']);
    expect(existsSync(join(dir, 'ws', 'a.txt'))).toBe(false);

    runs.resume(c.id, [{ type: 'approve' }]);
    expect(await waitStatus(runs, c.id, ['done', 'failed', 'waiting_approval'])).toBe('done');
    expect(existsSync(join(dir, 'ws', 'a.txt'))).toBe(true);
    expect(calls[1].at(-1)).toBe(`human:${steeringText('写完再告诉我路径')}`);
    expect(calls[1].at(-2)).toMatch(/^tool:/);
    expect(runs.listPending(c.id)).toEqual([]);
  });

  it('子 agent 在跑的时候发来的消息只给主 agent：子 agent 看不到，等它返回后主 agent 的下一次调用才插入', async () => {
    const runs = buildRuns(
      scripted(
        toolCall('task', { description: '跑一条慢命令', subagent_type: 'general-purpose' }, 't1'),
        slowCommand('x1'), // 子 agent 第 1 次调用
        new AIMessage('子任务完成'), // 子 agent 第 2 次调用
        new AIMessage('全部完成'), // 主 agent 第 2 次调用
      ),
    );
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '交给子 agent', []);
    // 子 agent 的 execute 开始了（主 agent 的 task 调用 + 子 agent 的 execute 调用）
    await toolStarted(c.id, 2);
    await runs.enqueue(c.id, '结果用表格给我', [], 'steer');
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');

    expect(calls).toHaveLength(4);
    const note = steeringText('结果用表格给我');
    // 子 agent 的两次调用都没有这条消息
    expect(calls[1].join('\n')).not.toContain(note);
    expect(calls[2].join('\n')).not.toContain(note);
    // 主 agent 的第 2 次调用：task 的结果之后才是它
    expect(calls[3].at(-1)).toBe(`human:${note}`);
    expect(calls[3].at(-2)).toMatch(/^tool:/);
  });
});

describe('排队消息（queue）与待发列表', () => {
  it('排队的多条消息：这一轮结束后合并进同一轮，按发出顺序，都是普通用户消息', async () => {
    const runs = buildRuns(scripted(slowCommand('x1'), new AIMessage('第一轮完成'), new AIMessage('第二轮完成')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '第一轮', []);
    await toolStarted(c.id);
    await runs.enqueue(c.id, '然后做 A', [], 'queue');
    await runs.enqueue(c.id, '再做 B', [], 'queue');
    await vi.waitFor(() => expect(resultCount(c.id)).toBe(2), { timeout: 10_000 });
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');

    expect(calls).toHaveLength(3);
    // 第一轮里看不到排队的消息
    expect(calls[1].join('\n')).not.toContain('然后做 A');
    // 第二轮：两条一起、按顺序、只触发一轮
    expect(calls[2].slice(-2)).toEqual(['human:然后做 A', 'human:再做 B']);
    expect(rowsOf(c.id).filter((r) => r.startsWith('user'))).toEqual(['user:第一轮', 'user:然后做 A', 'user:再做 B']);
    expect(runs.listPending(c.id)).toEqual([]);
  });

  it('以 / 开头的命令：按 Enter 发也进排队（不在运行中途改系统提示）', async () => {
    const runs = buildRuns(scripted(slowCommand('x1'), new AIMessage('完成'), new AIMessage('第二轮')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '第一轮', []);
    await toolStarted(c.id);
    await runs.enqueue(c.id, '/some-skill 做点事', [], 'steer');
    expect(runs.listPending(c.id).map((p) => p.kind)).toEqual(['queue']);
    await vi.waitFor(() => expect(resultCount(c.id)).toBe(2), { timeout: 10_000 });
    expect(calls[1].join('\n')).not.toContain('/some-skill');
    expect(calls[2].at(-1)).toBe('human:/some-skill 做点事');
  });

  it('被停止：没送达的消息留在待发列表、不自动开跑；删一条、再点发送，剩下的作为新一轮发出', async () => {
    const runs = buildRuns(scripted(toolCall('execute', { command: 'sleep 30' }, 'x1'), new AIMessage('新一轮完成')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.start(c.id, '跑个很慢的命令', []);
    await toolStarted(c.id);
    await runs.enqueue(c.id, '插入的', [], 'steer');
    await runs.enqueue(c.id, '排队的', [], 'queue');
    await runs.enqueue(c.id, '不要了', [], 'queue');
    await runs.stopAndWait(c.id);

    expect(repo.require(c.id).status).toBe('stopped');
    await new Promise((r) => setTimeout(r, 200));
    expect(runs.isRunning(c.id)).toBe(false);
    expect(calls).toHaveLength(1);
    const left = runs.listPending(c.id);
    expect(left.map((p) => p.text)).toEqual(['插入的', '排队的', '不要了']);

    // 重启应用（换一个 RunService 实例）：待发消息还在
    const again = buildRuns(scripted(new AIMessage('新一轮完成')));
    expect(again.listPending(c.id).map((p) => p.text)).toEqual(['插入的', '排队的', '不要了']);

    expect(again.removePending(c.id, left[2].id)?.text).toBe('不要了');
    expect(again.removePending(c.id, left[2].id)).toBeNull();
    again.sendPending(c.id);
    expect(await waitStatus(again, c.id, ['done', 'failed'])).toBe('done');
    expect(calls.at(-1)?.slice(-2)).toEqual(['human:插入的', 'human:排队的']);
    expect(again.listPending(c.id)).toEqual([]);
  });

  it('停止后留着待发消息，用户另发一条新消息：新消息单独开一轮；留着的 steer 在这一轮的第一次模型调用前插入，queue 等这一轮结束', async () => {
    const first = buildRuns(scripted(toolCall('execute', { command: 'sleep 30' }, 'x1')));
    const c = repo.create(null, { permission: 'auto' });
    await first.start(c.id, '跑个很慢的命令', []);
    await toolStarted(c.id);
    await first.enqueue(c.id, '留着的插入', [], 'steer');
    await first.enqueue(c.id, '留着的排队', [], 'queue');
    await first.stopAndWait(c.id);
    calls = [];

    const runs = buildRuns(scripted(new AIMessage('新消息处理完'), new AIMessage('排队的也处理完')));
    await runs.start(c.id, '新消息', []);
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 10_000 });
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');
    expect(calls[0].slice(-2)).toEqual(['human:新消息', `human:${steeringText('留着的插入')}`]);
    expect(calls[1].at(-1)).toBe('human:留着的排队');
  });

  it('会话其实空闲（界面状态慢了半拍）时发来的「待发」消息：直接当普通消息开跑', async () => {
    const runs = buildRuns(scripted(new AIMessage('好的')));
    const c = repo.create(null, { permission: 'auto' });
    await runs.enqueue(c.id, '你好', [], 'steer');
    expect(await waitStatus(runs, c.id, ['done', 'failed'])).toBe('done');
    expect(calls[0]).toEqual(['human:你好']);
    expect(runs.listPending(c.id)).toEqual([]);
    expect(events.filter((e) => e.type === 'user_message')).toHaveLength(1);
    // 会话空闲时没有待发消息可发
    expect(() => runs.sendPending(c.id)).toThrow();
  });
});
