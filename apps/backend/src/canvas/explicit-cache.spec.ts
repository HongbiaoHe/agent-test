import { Type } from '@google/genai';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  ExplicitCacheRegistry,
  findSafeSplit,
  messagesToTranscript,
  planFollowingCache,
  rebuildThresholdChars,
  cacheKey,
  explicitCacheTtlSeconds,
  isCacheInvalidError,
  isExplicitCacheEnabled,
  toFunctionDeclarations,
  toGeminiSchema,
} from './explicit-cache';

describe('isExplicitCacheEnabled', () => {
  it('默认关（未设置就是关，这是本功能的默认姿态）', () => {
    expect(isExplicitCacheEnabled({})).toBe(false);
  });

  it("只认 '1' / 'true'（大小写与空格容错）", () => {
    expect(isExplicitCacheEnabled({ CANVAS_EXPLICIT_CACHE: '1' })).toBe(true);
    expect(isExplicitCacheEnabled({ CANVAS_EXPLICIT_CACHE: 'true' })).toBe(
      true,
    );
    expect(isExplicitCacheEnabled({ CANVAS_EXPLICIT_CACHE: ' TRUE ' })).toBe(
      true,
    );
  });

  it('其它值一律当关（含 0 / false / 拼错）', () => {
    for (const v of ['0', 'false', 'yes', 'on', '']) {
      expect(isExplicitCacheEnabled({ CANVAS_EXPLICIT_CACHE: v })).toBe(false);
    }
  });
});

describe('rebuildThresholdChars', () => {
  it('默认 2000 字符（实测值：8000 太高，一整轮都触发不了重建）', () => {
    expect(rebuildThresholdChars({})).toBe(2000);
  });

  it('可配，非法值回落默认', () => {
    expect(
      rebuildThresholdChars({ CANVAS_EXPLICIT_CACHE_REBUILD_CHARS: '1200' }),
    ).toBe(1200);
    expect(
      rebuildThresholdChars({ CANVAS_EXPLICIT_CACHE_REBUILD_CHARS: '0' }),
    ).toBe(2000);
    expect(
      rebuildThresholdChars({ CANVAS_EXPLICIT_CACHE_REBUILD_CHARS: 'abc' }),
    ).toBe(2000);
  });
});

describe('explicitCacheTtlSeconds', () => {
  it('默认 600 秒', () => {
    expect(explicitCacheTtlSeconds({})).toBe(600);
  });

  it('可配，非法值回落默认（不能让 0/负数把缓存搞成立即过期）', () => {
    expect(explicitCacheTtlSeconds({ CANVAS_EXPLICIT_CACHE_TTL: '120' })).toBe(
      120,
    );
    expect(explicitCacheTtlSeconds({ CANVAS_EXPLICIT_CACHE_TTL: '0' })).toBe(
      600,
    );
    expect(explicitCacheTtlSeconds({ CANVAS_EXPLICIT_CACHE_TTL: '-5' })).toBe(
      600,
    );
    expect(explicitCacheTtlSeconds({ CANVAS_EXPLICIT_CACHE_TTL: 'abc' })).toBe(
      600,
    );
  });
});

describe('toGeminiSchema', () => {
  const conv = (schema: z.ZodTypeAny) =>
    toGeminiSchema(
      JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as unknown,
    );

  it('对象 + 字符串/数字字段 → 大写 Type 枚举', () => {
    const out = conv(
      z.object({ text: z.string().describe('正文'), x: z.number() }),
    );
    expect(out?.type).toBe(Type.OBJECT);
    expect(out?.properties?.text.type).toBe(Type.STRING);
    expect(out?.properties?.text.description).toBe('正文');
    expect(out?.properties?.x.type).toBe(Type.NUMBER);
  });

  it('enum → 保留取值（canvas 的 add_node.type 就是 enum）', () => {
    const out = conv(z.object({ type: z.enum(['text', 'image_gen']) }));
    expect(out?.properties?.type.enum).toEqual(['text', 'image_gen']);
  });

  it('数组 → items 递归解出', () => {
    const out = conv(z.object({ options: z.array(z.string()) }));
    expect(out?.properties?.options.type).toBe(Type.ARRAY);
    expect(out?.properties?.options.items?.type).toBe(Type.STRING);
  });

  it('optional 字段（anyOf 展开）取具体分支，不退化成 null', () => {
    const out = conv(z.object({ label: z.string().optional() }));
    expect(out?.properties?.label.type).toBe(Type.STRING);
  });

  it('required 只保留必填项', () => {
    const out = conv(
      z.object({ must: z.string(), maybe: z.string().optional() }),
    );
    expect(out?.required).toEqual(['must']);
  });

  it('认不出的形状 → null（宁可不缓存，也不能喂半个签名给模型）', () => {
    expect(toGeminiSchema(null)).toBeNull();
    expect(toGeminiSchema({})).toBeNull();
    expect(toGeminiSchema({ type: 'weird' })).toBeNull();
    // 对象里有一个字段解不出来 → 整体放弃
    expect(
      toGeminiSchema({
        type: 'object',
        properties: { ok: { type: 'string' }, bad: { type: 'weird' } },
      }),
    ).toBeNull();
  });
});

describe('toFunctionDeclarations', () => {
  const mkTool = (name: string, schema?: z.ZodTypeAny) => ({
    name,
    description: `${name} 的说明`,
    schema,
  });

  it('转出 name/description/parameters', () => {
    const out = toFunctionDeclarations([
      mkTool('add_node', z.object({ text: z.string() })),
    ]);
    expect(out).toHaveLength(1);
    expect(out?.[0].name).toBe('add_node');
    expect(out?.[0].description).toBe('add_node 的说明');
    expect(out?.[0].parameters?.properties?.text.type).toBe(Type.STRING);
  });

  it('无参工具不带 parameters（Gemini 对空 OBJECT 会报错）', () => {
    const out = toFunctionDeclarations([mkTool('clear_canvas', z.object({}))]);
    expect(out?.[0].parameters).toBeUndefined();
  });

  it('任一工具转不出来 → 整体 null，调用方据此降级', () => {
    expect(toFunctionDeclarations([{ description: '没名字' }])).toBeNull();
    expect(
      toFunctionDeclarations([
        mkTool('ok', z.object({ a: z.string() })),
        { name: 'bad', description: 'x', schema: { type: 'weird' } },
      ]),
    ).toBeNull();
  });
});

describe('cacheKey', () => {
  const decls = [{ name: 'add_node', description: 'x' }];

  it('同一份 (模型, system prompt, 工具) → 同 key（可复用缓存）', () => {
    expect(cacheKey('gemini-3.5-flash', 'SYS', decls)).toBe(
      cacheKey('gemini-3.5-flash', 'SYS', decls),
    );
  });

  it('三者任一变化都换 key —— 否则模型会照着过期的提示词/签名干活', () => {
    const base = cacheKey('gemini-3.5-flash', 'SYS', decls);
    expect(cacheKey('gemini-3.6-flash', 'SYS', decls)).not.toBe(base);
    expect(cacheKey('gemini-3.5-flash', 'SYS 改了', decls)).not.toBe(base);
    expect(
      cacheKey('gemini-3.5-flash', 'SYS', [
        { name: 'add_node', description: 'x' },
        { name: 'delete_node', description: 'y' },
      ]),
    ).not.toBe(base);
  });
});

describe('ExplicitCacheRegistry', () => {
  it('TTL 内复用，连缓存真实大小一起返回（会计要用它校正 provider 的累加值）', () => {
    const r = new ExplicitCacheRegistry();
    const t0 = 1_000_000;
    r.set('k', 'cachedContents/abc', 9076, 600, t0);
    expect(r.get('k', t0 + 60_000)).toEqual({
      name: 'cachedContents/abc',
      tokens: 9076,
    });
    // 提前 30s 视为过期：600-30=570s 后就不再返回
    expect(r.get('k', t0 + 571_000)).toBeNull();
    expect(r.size).toBe(0); // 过期条目顺手清掉
  });

  it('invalidate 清掉记录（Gemini 侧失效时用）', () => {
    const r = new ExplicitCacheRegistry();
    r.set('k', 'cachedContents/abc', 9076, 600, 0);
    r.invalidate('k');
    expect(r.get('k', 1000)).toBeNull();
  });

  it('没建过的 key → null', () => {
    expect(new ExplicitCacheRegistry().get('nope')).toBeNull();
  });
});

describe('isCacheInvalidError', () => {
  it('识别缓存失效类错误（据此清缓存并降级重试）', () => {
    expect(isCacheInvalidError(new Error('CachedContent not found: xyz'))).toBe(
      true,
    );
    expect(isCacheInvalidError(new Error('cachedContent expired'))).toBe(true);
  });

  it('普通错误不误判（那些要照常抛出去）', () => {
    expect(isCacheInvalidError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isCacheInvalidError(new Error('network timeout'))).toBe(false);
    expect(isCacheInvalidError(null)).toBe(false);
  });
});

describe('跟随式缓存（历史文本化）', () => {
  const human = (t: string) => new HumanMessage(t);
  const aiCall = (name: string, args: Record<string, unknown>) =>
    new AIMessage({
      content: '',
      tool_calls: [{ id: `c-${name}`, name, args }],
    });
  const toolRet = (name: string, body: string) =>
    new ToolMessage({ tool_call_id: `c-${name}`, name, content: body });

  describe('messagesToTranscript', () => {
    it('按角色标注逐条文本化（用户 / 工具调用 / 工具返回 / 回复）', () => {
      const out = messagesToTranscript([
        human('加一个雨天节点'),
        aiCall('add_node', { text: '雨夜' }),
        toolRet('add_node', '{"nodeId":"aaa111"}'),
        new AIMessage('已添加 aaa111'),
      ]);
      expect(out).toContain('[用户] 加一个雨天节点');
      expect(out).toContain('[你调用工具] add_node({"text":"雨夜"})');
      expect(out).toContain('[工具返回] add_node → {"nodeId":"aaa111"}');
      expect(out).toContain('[你回复] 已添加 aaa111');
    });

    it('没有可写内容 → 空串（调用方据此只缓存 system + 工具）', () => {
      expect(messagesToTranscript([])).toBe('');
      expect(messagesToTranscript([new AIMessage('')])).toBe('');
    });
  });

  describe('findSafeSplit', () => {
    it('切点落在配对完整处——请求侧不能以孤立的工具返回开头，否则 Gemini 400', () => {
      const msgs = [
        human('a'), // 0
        aiCall('add_node', {}), // 1 ← 这里切会把 call/return 拆开
        toolRet('add_node', '{}'), // 2
        human('b'), // 3
      ];
      // 完整回合到 index 2，留一条给请求 → 切 3
      expect(findSafeSplit(msgs)).toBe(3);
    });

    it('工具调用未闭合时不把它算进可切范围', () => {
      const msgs = [human('a'), aiCall('add_node', {})];
      // 只有 index 0 是安全边界，且要留一条给请求
      expect(findSafeSplit(msgs)).toBe(1);
    });

    it('至少留一条给请求（Gemini 的 contents 不能为空）', () => {
      expect(findSafeSplit([human('only')])).toBe(0);
      expect(findSafeSplit([])).toBe(0);
    });

    it('回归：末尾是工具返回时要退到上一个安全边界，不能只减 1', () => {
      // 曾经的 bug：min(最后边界, length-1) 会把切点落在 index 4 的工具返回上，
      // 请求于是以孤立 functionResponse 开头 → Gemini 400
      const msgs = [
        human('a'), // 0
        aiCall('add_node', {}), // 1
        toolRet('add_node', '{}'), // 2
        aiCall('add_node', {}), // 3
        toolRet('add_node', '{}'), // 4  ← 切在这里会拆开 3/4
      ];
      expect(findSafeSplit(msgs)).toBe(3); // 退到第一个回合结束处
    });

    it('回归：多个连续工具返回也不能被拆开', () => {
      const msgs = [
        human('a'), // 0
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'c1', name: 'add_node', args: {} },
            { id: 'c2', name: 'add_node', args: {} },
          ],
        }), // 1 ← 两个 call
        toolRet('add_node', '{}'), // 2
        toolRet('add_node', '{}'), // 3 ← 配对到这里才闭合
      ];
      // 唯一可用的安全边界是 index 0 之后（1 之后未闭合、4 超界）
      expect(findSafeSplit(msgs)).toBe(1);
    });
  });

  describe('planFollowingCache', () => {
    const convo = [
      human('a'),
      aiCall('add_node', { text: 'x'.repeat(200) }),
      toolRet('add_node', '{}'),
      human('b'),
    ];

    it('首次一定建（还没有任何缓存，不看增量阈值）', () => {
      const plan = planFollowingCache(convo, 0, 100_000);
      expect(plan?.splitAt).toBe(3);
      expect(plan?.transcript).toContain('[用户] a');
    });

    it('增量不够阈值 → 不重建（重建要花 create 调用 + 存储费）', () => {
      expect(planFollowingCache(convo, 1, 100_000)).toBeNull();
    });

    it('增量够了 → 重建，并把历史一起放进 transcript', () => {
      const plan = planFollowingCache(convo, 1, 10);
      expect(plan?.splitAt).toBe(3);
      expect(plan?.transcript).toContain('[工具返回]');
    });

    it('没有新的安全切点 → 不重建', () => {
      expect(planFollowingCache(convo, 3, 1)).toBeNull();
    });
  });
});
