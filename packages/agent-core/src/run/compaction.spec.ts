import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { countTokensApproximately } from 'langchain';
import { compactHistory, historyBudgetFor } from './compaction';
import type { HistoryEntry, ReplayHistory } from './history';

/** 记下收到的提示词、按脚本回复的假模型（cast-at-injection：只实现 compactHistory 用到的 invoke） */
function fakeModel(reply: string | Error) {
  const prompts: string[] = [];
  const model = {
    profile: {},
    invoke: (messages: BaseMessage[]) => {
      prompts.push(messages[0].text);
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(new AIMessage(reply));
    },
  };
  return { model: model as unknown as BaseChatModel, prompts };
}

const big = (n: number) => '字'.repeat(n);

function history(
  messages: BaseMessage[],
  summary: ReplayHistory['summary'] = null,
): ReplayHistory {
  const entries: HistoryEntry[] = messages.map((message, i) => ({
    seq: i * 10,
    message,
  }));
  return { entries, summary, userTexts: [] };
}

describe('historyBudgetFor', () => {
  it('没有画像用固定值；有画像按比例且不超过固定上限', () => {
    expect(historyBudgetFor()).toEqual({
      triggerTokens: 150_000,
      keepTokens: 30_000,
    });
    expect(historyBudgetFor(128_000)).toEqual({
      triggerTokens: 64_000,
      keepTokens: 12_800,
    });
    expect(historyBudgetFor(1_000_000)).toEqual({
      triggerTokens: 150_000,
      keepTokens: 30_000,
    });
  });
});

describe('compactHistory', () => {
  const budget = { triggerTokens: 1_000, keepTokens: 300 };

  it('没超预算原样返回，旧摘要并进第一条用户消息', async () => {
    const { model, prompts } = fakeModel('不该调用');
    const out = await compactHistory({
      history: history([new HumanMessage('q'), new AIMessage('a')], {
        text: '旧摘要',
        uptoSeq: -1,
      }),
      model,
      budget,
    });
    expect(prompts).toHaveLength(0);
    expect(out.newSummary).toBeNull();
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].text).toContain('旧摘要');
    expect(out.messages[0].text.endsWith('q')).toBe(true);
  });

  it('超预算：切点落在用户消息上（不拆工具调用对），切掉的部分摘要，保留段在预算内', async () => {
    const { model, prompts } = fakeModel('新摘要');
    const msgs = [
      new HumanMessage(`早 ${big(2000)}`),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c', name: 'read_file', args: {}, type: 'tool_call' },
        ],
      }),
      new ToolMessage({
        content: big(5000),
        tool_call_id: 'c',
        name: 'read_file',
      }),
      new AIMessage('读完了'),
      new HumanMessage('现在的问题'),
      new AIMessage('回答'),
    ];
    const out = await compactHistory({ history: history(msgs), model, budget });
    expect(out.newSummary).toEqual({ text: '新摘要', uptoSeq: 30 });
    expect(out.messages.map((m) => m.getType())).toEqual(['human', 'ai']);
    expect(out.messages[0].text).toContain('新摘要');
    expect(out.messages[0].text).toContain('现在的问题');
    expect(countTokensApproximately(out.messages)).toBeLessThan(
      budget.triggerTokens,
    );
    // 摘要原文带工具调用名与截断后的结果
    expect(prompts[0]).toContain('调用工具 read_file');
    expect(prompts[0]).toContain('...(已截断)');
  });

  it('再次压缩时把旧摘要一起交给摘要模型', async () => {
    const { model, prompts } = fakeModel('合并摘要');
    await compactHistory({
      history: history(
        [
          new HumanMessage(big(5000)),
          new AIMessage('a'),
          new HumanMessage('now'),
        ],
        { text: '最早的摘要', uptoSeq: -1 },
      ),
      model,
      budget,
    });
    expect(prompts[0]).toContain('## 更早的摘要\n最早的摘要');
  });

  it('只有本轮一条用户消息时没东西可摘要，原样返回', async () => {
    const { model, prompts } = fakeModel('x');
    const out = await compactHistory({
      history: history([new HumanMessage(big(8000))]),
      model,
      budget,
    });
    expect(prompts).toHaveLength(0);
    expect(out.newSummary).toBeNull();
  });

  it('摘要失败不阻断：记日志，本轮只重放保留段，不落新摘要', async () => {
    const { model } = fakeModel(new Error('boom'));
    const errors: unknown[] = [];
    const out = await compactHistory({
      history: history([
        new HumanMessage(big(5000)),
        new AIMessage('a'),
        new HumanMessage('now'),
      ]),
      model,
      budget,
      onError: (e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(out.newSummary).toBeNull();
    expect(out.messages.map((m) => m.text)).toEqual(['now']);
  });

  it('被停止时把错误抛出（不吞成降级）', async () => {
    const { model } = fakeModel(new Error('aborted'));
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      compactHistory({
        history: history([
          new HumanMessage(big(5000)),
          new AIMessage('a'),
          new HumanMessage('now'),
        ]),
        model,
        budget,
        signal: ctl.signal,
      }),
    ).rejects.toThrow('aborted');
  });
});
