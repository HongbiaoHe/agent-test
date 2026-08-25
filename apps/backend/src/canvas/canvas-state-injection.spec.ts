import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  buildCanvasStateUpdate,
  buildPlanUpdate,
} from './canvas-state-injection';

const state = (messages: BaseMessage[] = []) => ({ messages });

describe('buildCanvasStateUpdate', () => {
  it('把画布状态作为一条新消息写进 state（返回值即 state 更新）', async () => {
    const update = await buildCanvasStateUpdate(
      state([new HumanMessage('原有对话')]),
      's1',
      async () => '## 当前画布实时状态\nv1',
    );
    expect(update?.messages).toHaveLength(1);
    expect(update?.messages[0].text).toBe('## 当前画布实时状态\nv1');
  });

  it('画布未变 → 返回 undefined 不注入（本次调用前缀与上次完全一致 = 纯命中）', async () => {
    const snapshot = '## 当前画布实时状态\nv1';
    const update = await buildCanvasStateUpdate(
      state([new HumanMessage('原有对话'), new HumanMessage(snapshot)]),
      's1',
      async () => snapshot,
    );
    expect(update).toBeUndefined();
  });

  it('只比对最后一份快照：画布变回旧值也算变化，照样追加', async () => {
    const update = await buildCanvasStateUpdate(
      state([
        new HumanMessage('## 当前画布实时状态\nv1'),
        new HumanMessage('## 当前画布实时状态\nv2'),
      ]),
      's1',
      async () => '## 当前画布实时状态\nv1',
    );
    expect(update?.messages[0].text).toBe('## 当前画布实时状态\nv1');
  });

  it('无 sessionId / 无取数函数 / 状态为空 → 一律不注入', async () => {
    expect(
      await buildCanvasStateUpdate(state(), undefined, async () => 'x'),
    ).toBeUndefined();
    expect(
      await buildCanvasStateUpdate(state(), 's1', undefined),
    ).toBeUndefined();
    expect(
      await buildCanvasStateUpdate(state(), 's1', async () => ''),
    ).toBeUndefined();
  });

  /**
   * 回归护栏：按 langchain 的真实语义驱动多轮循环 —— beforeModel 的返回值进 state，
   * 模型回复也进 state。断言早先的消息**逐字不变**，前缀只在末尾增长。
   *
   * 这正是 wrapModelCall 版本做不到的：那时注入的消息不写回 state，下一轮从 state.messages
   * 重新开始，快照每次都"漂"在末尾 → 前缀在末尾分叉、缓存作废。
   */
  it('多轮驱动下前缀 append-only：既有消息逐字不变，只在末尾增长', async () => {
    let messages: BaseMessage[] = [new HumanMessage('原有对话')];
    const snapshots = ['v1', 'v1', 'v2']; // 中间一轮画布没变

    for (const v of snapshots) {
      const update = await buildCanvasStateUpdate(
        state(messages),
        's1',
        async () => `## 当前画布实时状态\n${v}`,
      );
      messages = [...messages, ...(update?.messages ?? [])];
      messages = [...messages, new AIMessage('好的')]; // 模型回复也进 state
    }

    expect(messages.map((m) => m.text)).toEqual([
      '原有对话',
      '## 当前画布实时状态\nv1',
      '好的',
      // 第二轮画布没变 → 没有新快照，只有模型回复
      '好的',
      '## 当前画布实时状态\nv2',
      '好的',
    ]);
  });
});

describe('buildPlanUpdate', () => {
  it('把任务计划作为一条新消息写进 state', () => {
    const update = buildPlanUpdate(state(), '## 当前任务计划\n1. [pending] a');
    expect(update?.messages[0].text).toBe('## 当前任务计划\n1. [pending] a');
  });

  it('计划未变 → 不重复注入（run 内 activePlan 是常量，只注入一次）', () => {
    const plan = '## 当前任务计划\n1. [pending] a';
    expect(
      buildPlanUpdate(state([new HumanMessage(plan)]), plan),
    ).toBeUndefined();
  });

  it('计划推进（跨 run）→ 追加新的一份，而不是改写旧的', () => {
    const old = '## 当前任务计划\n1. [pending] a';
    const next = '## 当前任务计划\n1. [completed] a';
    const update = buildPlanUpdate(state([new HumanMessage(old)]), next);
    expect(update?.messages[0].text).toBe(next);
  });

  it('无计划 → 不注入', () => {
    expect(buildPlanUpdate(state(), undefined)).toBeUndefined();
    expect(buildPlanUpdate(state(), '')).toBeUndefined();
  });
});
