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
        messageId: 'm1',
        model: 'gemini-3.1-pro-preview',
        input: 1000,
        output: 50,
        total: 1050,
        cacheRead: 800,
        cacheCreation: 120,
      },
    ]);
  });

  it('显式缓存下改用缓存真实大小，而不是 provider 报的累加值', () => {
    // 实测：9076 的显式缓存被流式聚合累加成 36304，input 只有 10418。
    // 用累加值会算出 348%，只做截断会贴到 100%，都不是真实命中量。
    const usages = extractUsages(
      update(
        aiMsg('m1', {
          input_tokens: 10418,
          output_tokens: 333,
          total_tokens: 11529,
          input_token_details: { cache_read: 36304 },
        }),
      ),
      new Set(),
      'gemini-3.6-flash',
      9076, // 建缓存时 API 回的真实大小
    );
    expect(usages[0].cacheRead).toBe(9076);
    // 命中率因此是 9076/10418 ≈ 87%，而不是 100% 或 348%
  });

  it('显式缓存比 input 还大（极短请求）→ 仍截到 input，守住 cacheRead ⊆ input', () => {
    const usages = extractUsages(
      update(
        aiMsg('m1', {
          input_tokens: 500,
          output_tokens: 10,
          total_tokens: 510,
          input_token_details: { cache_read: 9076 },
        }),
      ),
      new Set(),
      'gemini-3.6-flash',
      9076,
    );
    expect(usages[0].cacheRead).toBe(500);
  });

  it('未开显式缓存 → 仍走 provider 的值（隐式缓存口径不变）', () => {
    const usages = extractUsages(
      update(
        aiMsg('m1', {
          input_tokens: 10000,
          output_tokens: 100,
          total_tokens: 10100,
          input_token_details: { cache_read: 8192 },
        }),
      ),
      new Set(),
      'gemini-3.6-flash',
    );
    expect(usages[0].cacheRead).toBe(8192);
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

  it('预热的 seen（已落库 messageId）拦住 checkpointer 重放的历史调用', () => {
    // 跨 run 场景：run2 启动时 checkpointer 把 run1 的 AIMessage 重新 emit 到 updates 流。
    // 用已落库的 messageId 预热 seen 后，重放不再记账；只有本 run 的新消息才记。
    const seen = new Set<string>(['old1', 'old2']);
    const usages = extractUsages(
      update(
        aiMsg('old1', { input_tokens: 10, output_tokens: 1, total_tokens: 11 }),
        aiMsg('old2', { input_tokens: 20, output_tokens: 2, total_tokens: 22 }),
        aiMsg('new1', { input_tokens: 30, output_tokens: 3, total_tokens: 33 }),
      ),
      seen,
      'x',
    );
    expect(usages.map((u) => u.messageId)).toEqual(['new1']);
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
        reasoning: 0,
        total: 330,
        cacheRead: 210,
        cacheCreation: 0,
      },
    );
  });

  it('Gemini 口径：total 大于 input+output 时把差额记为思考量', () => {
    // 实测 gemini-3.5-flash：in=16 out=742 total=1911 → 思考 1153
    const gemini: CanvasTokenCall = {
      id: 'g1',
      model: 'gemini-3.5-flash',
      input: 16,
      output: 742,
      total: 1911,
      cacheRead: 0,
      cacheCreation: 0,
      at: '2026-08-25T00:00:00.000Z',
    };
    const t = sumCalls([gemini]);
    expect(t.reasoning).toBe(1153);
    // 关键不变式：输入 + 输出 + 思考 = 总计（弹窗里的数字要能对上）
    expect(t.input + t.output + t.reasoning).toBe(t.total);
  });

  it('DeepSeek 口径：reasoning 计入 output，思考量记 0 不重复计', () => {
    expect(sumCalls([call('deepseek-flash', 100, 900)]).reasoning).toBe(0);
  });

  it('空调用 → 全零（前端据此避免除零算命中率）', () => {
    expect(sumCalls([])).toEqual({
      calls: 0,
      input: 0,
      output: 0,
      reasoning: 0,
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
        reasoning: 0,
        total: 550,
        cacheRead: 400,
        cacheCreation: 0,
      },
      {
        model: 'flash',
        calls: 2,
        input: 30,
        output: 3,
        reasoning: 0,
        total: 33,
        cacheRead: 0,
        cacheCreation: 0,
      },
    ]);
  });
});
