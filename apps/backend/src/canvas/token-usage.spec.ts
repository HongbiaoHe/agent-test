import { AIMessage } from '@langchain/core/messages';
import type { UsageMetadata } from '@langchain/core/messages';
import { extractUsages, groupByModel, sumCalls } from './token-usage';
import type { CanvasTokenCall } from './canvas.types';

const aiMsg = (
  id: string,
  usage: UsageMetadata | undefined,
  responseMetadata: Record<string, string> = {},
) =>
  new AIMessage({
    id,
    content: '',
    usage_metadata: usage,
    response_metadata: responseMetadata,
  });

/** 包成 updates 模式的节点更新形状：{ [node]: { messages: [...] } }。 */
const update = (...msgs: AIMessage[]) => ({
  model_request: { messages: msgs },
});

describe('extractUsages', () => {
  it('抽取输入/输出/总量与缓存明细（cache_read / cache_creation）', () => {
    const usages = extractUsages(
      update(
        aiMsg('m1', {
          input_tokens: 1000,
          output_tokens: 50,
          total_tokens: 1050,
          input_token_details: { cache_read: 800, cache_creation: 120 },
        }),
      ),
      new Set(),
      'gemini-3.1-pro-preview',
    );
    expect(usages).toEqual([
      {
        model: 'gemini-3.1-pro-preview',
        input: 1000,
        output: 50,
        total: 1050,
        cacheRead: 800,
        cacheCreation: 120,
      },
    ]);
  });

  it('无 input_token_details（provider 未回缓存数据）→ 缓存量按 0', () => {
    const usages = extractUsages(
      update(
        aiMsg('m1', {
          input_tokens: 10,
          output_tokens: 2,
          total_tokens: 12,
        }),
      ),
      new Set(),
      'gemini-3.5-flash',
    );
    expect(usages[0]).toMatchObject({ cacheRead: 0, cacheCreation: 0 });
  });

  it('模型名优先取响应里的 model_name，取不到才回落', () => {
    const usages = extractUsages(
      update(
        aiMsg(
          'm1',
          { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
          { model_name: 'deepseek-v4-pro' },
        ),
        aiMsg(
          'm2',
          { input_tokens: 7, output_tokens: 1, total_tokens: 8 },
          { model_provider: 'google-genai' },
        ),
      ),
      new Set(),
      'gemini-3.1-pro-preview',
    );
    expect(usages.map((u) => u.model)).toEqual([
      'deepseek-v4-pro',
      'gemini-3.1-pro-preview',
    ]);
  });

  it('一次更新里的多条新消息全部记账（不能只取第一条）', () => {
    const usages = extractUsages(
      update(
        aiMsg('m1', { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
        aiMsg('m2', { input_tokens: 20, output_tokens: 2, total_tokens: 22 }),
      ),
      new Set(),
      'gemini-3.1-pro-preview',
    );
    expect(usages.map((u) => u.total)).toEqual([11, 22]);
  });

  it('同一 message id 跨节点回显只记一次', () => {
    const seen = new Set<string>();
    const msg = aiMsg('m1', {
      input_tokens: 10,
      output_tokens: 1,
      total_tokens: 11,
    });
    expect(extractUsages(update(msg), seen, 'x')).toHaveLength(1);
    expect(extractUsages(update(msg), seen, 'x')).toHaveLength(0);
  });

  it('无 usage_metadata / 全零用量 → 不记账', () => {
    expect(
      extractUsages(update(aiMsg('m1', undefined)), new Set(), 'x'),
    ).toEqual([]);
    expect(
      extractUsages(
        update(
          aiMsg('m2', {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          }),
        ),
        new Set(),
        'x',
      ),
    ).toEqual([]);
  });

  it('非对象 / 无 messages 的更新 → 空数组（不阻断运行）', () => {
    expect(extractUsages(null, new Set(), 'x')).toEqual([]);
    expect(extractUsages({ tools: { other: 1 } }, new Set(), 'x')).toEqual([]);
  });
});

const call = (
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
): CanvasTokenCall => ({
  id: `${model}-${input}-${output}`,
  model,
  input,
  output,
  total: input + output,
  cacheRead,
  cacheCreation: 0,
  at: '2026-07-25T00:00:00.000Z',
});

describe('sumCalls', () => {
  it('合计各项并记录调用次数', () => {
    expect(sumCalls([call('a', 100, 10, 60), call('a', 200, 20, 150)])).toEqual(
      {
        calls: 2,
        input: 300,
        output: 30,
        total: 330,
        cacheRead: 210,
        cacheCreation: 0,
      },
    );
  });

  it('空调用 → 全零（前端据此避免除零算命中率）', () => {
    expect(sumCalls([])).toEqual({
      calls: 0,
      input: 0,
      output: 0,
      total: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });
});

describe('groupByModel', () => {
  it('按模型聚合，并按总量倒序', () => {
    const groups = groupByModel([
      call('flash', 10, 1),
      call('pro', 500, 50, 400),
      call('flash', 20, 2),
    ]);
    expect(groups).toEqual([
      {
        model: 'pro',
        calls: 1,
        input: 500,
        output: 50,
        total: 550,
        cacheRead: 400,
        cacheCreation: 0,
      },
      {
        model: 'flash',
        calls: 2,
        input: 30,
        output: 3,
        total: 33,
        cacheRead: 0,
        cacheCreation: 0,
      },
    ]);
  });
});
