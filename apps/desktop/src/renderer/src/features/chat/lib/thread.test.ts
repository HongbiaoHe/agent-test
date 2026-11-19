import { describe, expect, it, vi } from 'vitest';

import type { Conversation, ConversationMessage } from '@/lib/api';

// thread.ts → background-tasks → agent-client 在模块加载时挂 window 监听；纯函数单测用不到 RPC，桩掉
vi.mock('@/lib/agent-client', () => ({ agent: {} }));

import { buildBaseState, emptyState, findToolItem, foldLive, type NormalizedEvent, type ThreadItem, type ThreadState } from './thread';

type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;

const subA = { callId: 'call-a', name: 'researcher' };
const subB = { callId: 'call-b', name: 'writer' };

let clock = 1_000;
/** 实时事件：时间单调递增 */
function ev(type: string, payload: Record<string, unknown>): NormalizedEvent {
  clock += 10;
  return { type, payload, at: clock };
}
const sub = (agent: { callId: string; name: string }, type: string, payload: Record<string, unknown>) =>
  ev(type, { ...payload, subagent: agent });

function taskCall(id: string, subagentType: string, description: string) {
  return { id, name: 'task', args: { description, subagent_type: subagentType } };
}

function chip(state: ThreadState, callId: string): ToolItem {
  const it = state.items.find((x): x is ToolItem => x.kind === 'tool' && x.callId === callId);
  if (!it) throw new Error(`chip ${callId} not found`);
  return it;
}
function subItems(state: ThreadState, callId: string): ThreadItem[] {
  return chip(state, callId).sub?.items ?? [];
}

describe('thread: sub-agent events fold into the task chip', () => {
  it('keeps interleaved parallel sub-agents out of the main thread and seals them on tool_end / result', () => {
    const events: NormalizedEvent[] = [
      { type: 'message', role: 'user', payload: { text: 'go' }, at: 1_000 },
      ev('token', { text: 'Delegating' }),
      ev('message', { text: 'Delegating' }),
      ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'find facts'), taskCall('call-b', 'writer', 'draft')] }),
      sub(subA, 'token', { text: 'A1' }),
      sub(subB, 'token', { text: 'B1' }),
      sub(subA, 'token', { text: 'A2' }),
      sub(subA, 'message', { text: 'A1A2' }),
      sub(subA, 'tool_start', { tool_calls: [{ id: 'a-read', name: 'read_file', args: { file_path: '/x.md' } }] }),
      sub(subB, 'reasoning', { text: 'thinking B', sourceId: 'b-msg-1' }),
      sub(subA, 'tool_end', { name: 'read_file', toolCallId: 'a-read', content: 'file body' }),
      sub(subB, 'token', { text: 'B2' }),
      sub(subA, 'message', { text: 'A done' }),
      ev('tool_end', { name: 'task', toolCallId: 'call-a', content: 'final A' }),
      sub(subB, 'message', { text: 'B1B2' }),
      ev('tool_end', { name: 'task', toolCallId: 'call-b', content: 'final B' }),
      ev('token', { text: 'All ' }),
      ev('token', { text: 'done' }),
      ev('message', { text: 'All done' }),
      ev('result', { status: 'done' }),
    ];
    const state = foldLive(emptyState, events);

    // 主线程：用户、主 agent 正文、两个 task chip、收尾正文、本轮耗时 —— 子 agent 的正文 / 工具一个都不在
    expect(state.items.map((it) => it.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'turn']);
    const mainTexts = state.items.flatMap((it) => (it.kind === 'assistant' ? [it.text] : []));
    expect(mainTexts).toEqual(['Delegating', 'All done']);
    expect(state.items.some((it) => it.kind === 'assistant' && it.streaming)).toBe(false);
    expect(state.status).toBe('done');
    expect(state.pendingSub).toEqual([]);

    const a = chip(state, 'call-a');
    expect(a).toMatchObject({ name: 'task', done: true, result: 'final A' });
    expect(subItems(state, 'call-a')).toMatchObject([
      { kind: 'assistant', text: 'A1A2', streaming: false },
      { kind: 'tool', callId: 'a-read', name: 'read_file', done: true, result: 'file body' },
      { kind: 'assistant', text: 'A done', streaming: false },
    ]);
    // 嵌套 item id 带父 chip 前缀，与主线程不冲突；详情面板能按 id 找到嵌套 chip
    const nestedTool = subItems(state, 'call-a')[1];
    expect(nestedTool.id.startsWith(`${a.id}.`)).toBe(true);
    expect(findToolItem(state.items, nestedTool.id)).toBe(nestedTool);

    expect(chip(state, 'call-b')).toMatchObject({ done: true, result: 'final B' });
    // Gemini 式整块思考晚于正文增量到达：插在正在流的正文之前（与主线程同一规则）
    expect(subItems(state, 'call-b')).toMatchObject([
      { kind: 'reasoning', text: 'thinking B', streaming: false },
      { kind: 'assistant', text: 'B1B2', streaming: false },
    ]);
  });

  it('does not merge sub-agent tokens into the main streaming bubble', () => {
    const state = foldLive(emptyState, [
      ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'x')] }),
      ev('token', { text: 'main-1 ' }),
      sub(subA, 'token', { text: 'sub-1' }),
      ev('token', { text: 'main-2' }),
    ]);
    const main = state.items.filter((it) => it.kind === 'assistant');
    expect(main).toMatchObject([{ text: 'main-1 main-2', streaming: true }]);
    expect(subItems(state, 'call-a')).toMatchObject([{ kind: 'assistant', text: 'sub-1', streaming: true }]);
  });

  it('does not seal main reasoning, move main lastAt or touch the plan on sub-agent events', () => {
    const before = foldLive(emptyState, [
      ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'x')] }),
      ev('plan_update', { todos: [{ content: 'main step', status: 'in_progress' }] }),
      ev('reasoning', { text: 'main thought', sourceId: 'm1' }),
    ]);
    const after = foldLive(before, [
      sub(subA, 'tool_start', { tool_calls: [{ id: 's1', name: 'ls', args: {} }] }),
      sub(subA, 'plan_update', { todos: [{ content: 'sub step', status: 'pending' }] }),
    ]);
    expect(after.lastAt).toBe(before.lastAt);
    expect(after.items.find((it) => it.kind === 'reasoning')).toMatchObject({ streaming: true });
    expect(after.items.find((it) => it.kind === 'plan')).toMatchObject({ todos: [{ content: 'main step' }] });
    expect(after.items.filter((it) => it.kind === 'tool')).toHaveLength(1);
  });

  it('seals nested streaming text, reasoning and chips when the turn ends with result', () => {
    const state = foldLive(emptyState, [
      ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'x')] }),
      sub(subA, 'reasoning', { text: 'hmm', sourceId: 'r1' }),
      sub(subA, 'tool_start', { tool_calls: [{ id: 's1', name: 'execute', args: { command: 'ls' } }] }),
      sub(subA, 'token', { text: 'partial' }),
      ev('result', { status: 'stopped' }),
    ]);
    expect(chip(state, 'call-a').done).toBe(true);
    expect(subItems(state, 'call-a')).toMatchObject([
      { kind: 'reasoning', streaming: false },
      { kind: 'tool', done: true },
      { kind: 'assistant', text: 'partial', streaming: false },
    ]);
  });

  it('seals nested sub-threads on error without settling main chips', () => {
    const state = foldLive(emptyState, [
      ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'x')] }),
      sub(subA, 'token', { text: 'partial' }),
      ev('error', { message: 'boom' }),
    ]);
    expect(chip(state, 'call-a').done).toBe(false);
    expect(subItems(state, 'call-a')).toMatchObject([{ kind: 'assistant', streaming: false }]);
    expect(state.items.at(-1)).toMatchObject({ kind: 'error', text: 'boom' });
  });

  it('buffers sub-agent events that arrive before their task chip, and never leaks unmatched ones', () => {
    const early = foldLive(emptyState, [
      sub(subA, 'token', { text: 'early' }),
      sub({ callId: 'tools:orphan', name: '' }, 'message', { text: 'orphan text' }),
    ]);
    expect(early.items).toEqual([]);
    expect(early.pendingSub).toHaveLength(2);

    const state = foldLive(early, [ev('tool_start', { tool_calls: [taskCall('call-a', 'researcher', 'x')] })]);
    expect(subItems(state, 'call-a')).toMatchObject([{ kind: 'assistant', text: 'early', streaming: true }]);
    // 回退形态（tools:<id>）对不上任何 chip：留在缓冲里，不进主线程
    expect(state.items.map((it) => it.kind)).toEqual(['tool']);
    expect(state.pendingSub).toHaveLength(1);
  });

  it('ignores context_summary events entirely', () => {
    const before = foldLive(emptyState, [ev('reasoning', { text: 'x', sourceId: 'm1' })]);
    const after = foldLive(before, [ev('context_summary', { text: 'summary of earlier turns' })]);
    expect(after).toBe(before);
  });
});

describe('thread: history rebuild with sub-agent rows', () => {
  let seq = 0;
  const row = (role: string, type: string, content: Record<string, unknown>): ConversationMessage => {
    seq += 1;
    return { id: `m${seq}`, seq, role, type, content, createdAt: 10_000 + seq * 100 };
  };

  function conversation(status: string, messages: ConversationMessage[]): Conversation {
    return { id: 'c1', goal: 'go', title: null, status, messages, totalTokens: 0 };
  }

  const history = (): ConversationMessage[] => [
    row('system', 'context_summary', { text: 'summary of earlier turns', uptoSeq: 0 }),
    row('user', 'message', { text: 'go' }),
    row('assistant', 'tool_start', {
      tool_calls: [taskCall('call-a', 'researcher', 'find facts'), taskCall('call-b', 'writer', 'draft')],
    }),
    row('assistant', 'reasoning', { text: 'A thinks', sourceId: 'ra', subagent: subA }),
    row('assistant', 'tool_start', { tool_calls: [{ id: 'a-read', name: 'read_file', args: { file_path: '/x' } }], subagent: subA }),
    row('assistant', 'message', { text: 'B answer', subagent: subB }),
    row('tool', 'tool_end', { name: 'read_file', toolCallId: 'a-read', content: 'body', subagent: subA }),
    row('assistant', 'message', { text: 'A answer', subagent: subA }),
    row('tool', 'tool_end', { name: 'task', toolCallId: 'call-a', content: 'final A' }),
    row('tool', 'tool_end', { name: 'task', toolCallId: 'call-b', content: 'final B' }),
    row('assistant', 'message', { text: 'All done' }),
    row('assistant', 'result', { status: 'done' }),
  ];

  it('rebuilds nested sub-threads, keeps the main thread clean and renders nothing for context_summary', () => {
    const state = buildBaseState(conversation('done', history()));
    expect(state.items.map((it) => it.kind)).toEqual(['user', 'tool', 'tool', 'assistant', 'turn']);
    expect(subItems(state, 'call-a')).toMatchObject([
      { kind: 'reasoning', text: 'A thinks', streaming: false },
      { kind: 'tool', name: 'read_file', done: true, result: 'body' },
      { kind: 'assistant', text: 'A answer', streaming: false },
    ]);
    expect(subItems(state, 'call-b')).toMatchObject([{ kind: 'assistant', text: 'B answer' }]);
  });

  it('settles nested chips when history ends in a terminal status mid-delegation', () => {
    const rows = history().slice(0, 6); // 停在子 agent 运行中（read_file 没有 tool_end、task 没有结果）
    const stopped = buildBaseState(conversation('stopped', rows));
    expect(chip(stopped, 'call-a').done).toBe(true);
    expect(subItems(stopped, 'call-a')).toMatchObject([
      { kind: 'reasoning', streaming: false },
      { kind: 'tool', name: 'read_file', done: true },
    ]);

    // 仍在运行的会话不收尾 chip，但历史里的思考都是完整块（子线程末尾那块也收口）
    const running = buildBaseState(conversation('running', history().slice(0, 4)));
    expect(chip(running, 'call-a').done).toBe(false);
    expect(subItems(running, 'call-a')).toMatchObject([{ kind: 'reasoning', text: 'A thinks', streaming: false }]);
  });
});
