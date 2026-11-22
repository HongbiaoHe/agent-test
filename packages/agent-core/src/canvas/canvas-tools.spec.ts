import { HumanMessage } from '@langchain/core/messages';
import {
  buildAgentCanvasContext,
  type CanvasNodeDto,
  type CanvasOpInput,
} from '@agent-test/canvas-schema';
import { buildCanvasStateUpdate } from './canvas-state-middleware';
import { createCanvasTools, type CanvasToolBackend } from './canvas-tools';

const node = (
  id: string,
  over: Partial<CanvasNodeDto> = {},
): CanvasNodeDto => ({
  id,
  type: 'image_gen',
  x: 0,
  y: 0,
  version: 1,
  label: null,
  prompt: null,
  assetPath: null,
  mediaGenerationId: null,
  mediaChannel: null,
  mediaModel: null,
  mediaParams: null,
  mediaVersionId: null,
  mediaStatus: null,
  mediaMock: false,
  outputs: [],
  ...over,
});

/** 只实现快照与写入的执行端（不提供 resolveNodeId：走按快照解析的分支） */
function fakeBackend(
  nodes: CanvasNodeDto[],
  over: Partial<CanvasToolBackend> = {},
) {
  const ops: CanvasOpInput[] = [];
  const backend: CanvasToolBackend = {
    snapshot: () => Promise.resolve({ nodes, edges: [], mockMedia: false }),
    applyOp: (op) => {
      ops.push(op);
      return Promise.resolve({
        revision: ops.length,
        patch: { op: 'clear', revision: ops.length },
      });
    },
    findUploadedAsset: () => Promise.resolve(null),
    prepareNodeConfig: () => Promise.resolve({ ok: false, issues: [] }),
    createGeneration: () => Promise.resolve({ generationId: 'g1' }),
    createConcat: () => Promise.resolve({ generationId: 'c1' }),
    modelCatalog: () => Promise.resolve({ models: [] }),
    ...over,
  };
  return { backend, ops };
}

const toolNamed = (
  tools: ReturnType<typeof createCanvasTools>,
  name: string,
) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('createCanvasTools（共享画布工具）', () => {
  it('执行端不可用（desktop 对话没绑定画布）：每个工具都回一句说明给模型，不抛错', async () => {
    const tools = createCanvasTools(() =>
      Promise.resolve('当前对话还没有打开画布：先用 open_canvas'),
    );
    const out: unknown = await toolNamed(tools, 'delete_node').invoke({
      nodeId: 'x',
    });
    expect(JSON.parse(String(out))).toEqual({
      error: '当前对话还没有打开画布：先用 open_canvas',
    });
    const clear: unknown = await toolNamed(tools, 'clear_canvas').invoke({});
    expect(String(clear)).toContain('open_canvas');
  });

  it('执行端不提供 resolveNodeId 时按快照解析短 id；解析不到回「节点不存在」', async () => {
    const { backend, ops } = fakeBackend([
      node('cuid000aaaa11'),
      node('cuid000bbbb22'),
    ]);
    const tools = createCanvasTools(() => Promise.resolve(backend));
    // 短 id = 完整 id 末 6 位（shortNodeId）
    await toolNamed(tools, 'update_node').invoke({
      nodeId: 'aaaa11',
      label: '新标题',
    });
    expect(ops).toEqual([
      { op: 'update_node', nodeId: 'cuid000aaaa11', label: '新标题' },
    ]);
    const missing: unknown = await toolNamed(tools, 'delete_node').invoke({
      nodeId: 'zzzzzz',
    });
    expect(JSON.parse(String(missing))).toMatchObject({ error: '节点不存在' });
    // 不足 6 位的残缺 id 即使恰好唯一也不认，免得误删
    const partial: unknown = await toolNamed(tools, 'delete_node').invoke({
      nodeId: 'b22',
    });
    expect(JSON.parse(String(partial))).toMatchObject({ error: '节点不存在' });
    expect(ops).toHaveLength(1);
  });

  it('上传节点挂附件时用文件名兜底当标题，超过标题上限就截断', async () => {
    const longName = 'f'.repeat(240) + '.png';
    const { backend, ops } = fakeBackend([], {
      findUploadedAsset: () =>
        Promise.resolve({
          generationId: 'g9',
          type: 'image',
          filename: longName,
        }),
    });
    const tools = createCanvasTools(() => Promise.resolve(backend));
    await toolNamed(tools, 'add_node').invoke({
      type: 'image_upload',
      versionId: 'v9',
      x: 0,
      y: 0,
    });
    expect(ops[0]).toMatchObject({ op: 'add_node', label: 'f'.repeat(191) });
  });

  it('批量建节点：调用方中止后剩下的不再落库（MCP 客户端断开时不留「以为失败、其实建完」的节点）', async () => {
    const ac = new AbortController();
    const { backend, ops } = fakeBackend([], {
      applyOp: (op) => {
        ops.push(op);
        if (ops.length === 2) ac.abort();
        return Promise.resolve({
          revision: ops.length,
          patch: { op: 'clear', revision: ops.length },
        });
      },
    });
    const tools = createCanvasTools(() => Promise.resolve(backend));
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      type: 'image_upload',
      x: i,
      y: 0,
    }));
    await expect(
      toolNamed(tools, 'add_nodes').invoke({ nodes }, { signal: ac.signal }),
    ).rejects.toThrow();
    // 让工具函数跑完剩下的循环（invoke 已因中止先行返回）
    await new Promise((r) => setTimeout(r, 0));
    expect(ops).toHaveLength(2);
  });

  it('生成：执行端业务拒绝原样回给模型；成功后把 generationId 回填到节点', async () => {
    const gen = node('nodeGen000001', { prompt: '一只猫' });
    const rejected = fakeBackend([gen], {
      createGeneration: () =>
        Promise.resolve({ error: { code: 1, message: '测试模式已禁用' } }),
    });
    const r1: unknown = await toolNamed(
      createCanvasTools(() => Promise.resolve(rejected.backend)),
      'generate_media_node',
    ).invoke({ nodeId: gen.id });
    expect(JSON.parse(String(r1))).toEqual({
      error: { code: 1, message: '测试模式已禁用' },
    });
    expect(rejected.ops).toEqual([]);

    const ok = fakeBackend([gen]);
    const r2: unknown = await toolNamed(
      createCanvasTools(() => Promise.resolve(ok.backend)),
      'generate_media_node',
    ).invoke({ nodeId: gen.id });
    expect(JSON.parse(String(r2))).toMatchObject({
      generationId: 'g1',
      status: 'queued',
    });
    expect(ok.ops).toEqual([
      { op: 'update_node', nodeId: gen.id, mediaGenerationId: 'g1' },
    ]);
  });
});

describe('buildCanvasStateUpdate（画布状态注入）', () => {
  const text = buildAgentCanvasContext({
    nodes: [node('n1')],
    edges: [],
    focusNodeIds: [],
  });

  it('画布有内容且与上一份注入不同 → 追加一条；与最后一份相同 → 不注入；没有画布 → 不注入', async () => {
    const first = await buildCanvasStateUpdate({ messages: [] }, () =>
      Promise.resolve(text),
    );
    expect(first?.messages).toHaveLength(1);
    expect(first?.messages[0].text).toBe(text);
    const same = await buildCanvasStateUpdate(
      { messages: [new HumanMessage(text), new HumanMessage('继续')] },
      () => Promise.resolve(text),
    );
    expect(same).toBeUndefined();
    expect(
      await buildCanvasStateUpdate({ messages: [] }, () =>
        Promise.resolve(null),
      ),
    ).toBeUndefined();
  });
});
