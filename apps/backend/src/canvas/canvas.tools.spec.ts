import type { CanvasService } from './canvas.service';
import type { MediaService } from '../media/media.service';
import { createCanvasTools } from './canvas.tools';

/**
 * add_node 的必填参数校验。
 *
 * 起因是实测里模型漏传了 type（只给了 label/text/x/y）：交给 zod 直接拒的话，
 * 报错会以一大坨带堆栈的异常进对话历史、废掉一整轮。改成 handler 里返回一句话之后，
 * 这里锁住两件事——漏传要有明确回话且**不建节点**，传了要照常建。
 */
describe('add_node 的 type 校验', () => {
  const applyOp = jest.fn();
  const tools = createCanvasTools(
    // cast-at-injection：只用到 applyOp，其余方法本用例不触达
    { applyOp } as unknown as CanvasService,
    {} as unknown as MediaService,
    { sessionId: 's1', userId: 'u1' },
  );
  const addNode = tools.find((t) => t.name === 'add_node');

  beforeEach(() => applyOp.mockReset());

  it('漏传 type：回一句能照做的话，且不落任何 op', async () => {
    const out = await addNode!.invoke({
      label: '分镜',
      text: '正文',
      x: 0,
      y: 0,
    });

    expect(applyOp).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain('type');
    // 取值范围要列出来，模型才知道补什么
    expect(parsed.error).toContain('video_concat');
  });

  it('传了 type：照常建节点', async () => {
    applyOp.mockResolvedValue({
      patch: { op: 'add_node', node: { id: 'cmtjabc123456' } },
      revision: 7,
    });

    const out = await addNode!.invoke({ type: 'text', text: '正文' });

    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({ op: 'add_node', type: 'text' }),
    );
    expect(JSON.parse(out)).toMatchObject({ revision: 7 });
  });

  it('type 值非法仍由 schema 拦下（枚举照旧生效，只是不再管"缺失"）', async () => {
    // 越过 TS 的静态检查喂一个不存在的类型：这正是运行期要靠 zod 拦的那类输入
    const bad = { type: 'audio_gen' } as unknown as { type: 'text' };
    await expect(addNode!.invoke(bad)).rejects.toThrow();
    expect(applyOp).not.toHaveBeenCalled();
  });
});

/**
 * generate_media_node 用**节点上选定的模型**。
 *
 * agent 不参与选模型（它只决定"什么时候生成"），所以这里锁住两件事：
 * 节点配了模型就照配的传下去，没配就把三个字段都留空、由 MediaService 回落默认模型。
 * 素材收集（上游 text 拼提示词、上游 image_gen 作参考图）与用户手动触发共用同一段逻辑，
 * 这两个用例同时覆盖它。
 */
describe('generate_media_node 的模型来源', () => {
  const textNode = {
    id: 'n-text',
    type: 'text',
    outputs: [{ type: 'text', content: '一只柯基' }],
  };
  const refNode = {
    id: 'n-ref',
    type: 'image_gen',
    outputs: [{ type: 'image', content: 'ver-ref' }],
  };

  function harness(genNode: Record<string, unknown>) {
    const applyOp = jest.fn().mockResolvedValue({ revision: 1 });
    const createGeneration = jest
      .fn()
      .mockResolvedValue({ generationId: 'gen-1', versionId: 'ver-1' });
    const resolveNodeId = jest.fn().mockResolvedValue(genNode.id);
    const agentSnapshot = jest.fn().mockResolvedValue({
      nodes: [textNode, refNode, genNode],
      edges: [
        { source: 'n-text', target: genNode.id },
        { source: 'n-ref', target: genNode.id },
      ],
    });
    const tools = createCanvasTools(
      // cast-at-injection：只用到这两个方法
      { applyOp, agentSnapshot, resolveNodeId } as unknown as CanvasService,
      { createGeneration } as unknown as MediaService,
      { sessionId: 's1', userId: 'u1' },
    );
    return {
      tool: tools.find((t) => t.name === 'generate_media_node')!,
      createGeneration,
    };
  }

  it('节点配了模型 → 原样传给 MediaService', async () => {
    const { tool, createGeneration } = harness({
      id: 'n-gen',
      type: 'image_gen',
      outputs: [],
      mediaChannel: 'google',
      mediaModel: 'nano-banana-2',
      mediaParams: { aspect_ratio: '16:9', resolution: '1K' },
    });

    await tool.invoke({ nodeId: 'n-gen' });

    expect(createGeneration).toHaveBeenCalledWith(
      's1',
      'u1',
      'image',
      '一只柯基',
      ['ver-ref'],
      {
        channel: 'google',
        model: 'nano-banana-2',
        params: { aspect_ratio: '16:9', resolution: '1K' },
      },
    );
  });

  it('节点没配模型 → 三个字段都留空，由 MediaService 回落默认模型', async () => {
    const { tool, createGeneration } = harness({
      id: 'n-gen',
      type: 'video_gen',
      outputs: [],
      mediaChannel: null,
      mediaModel: null,
      mediaParams: null,
    });

    await tool.invoke({ nodeId: 'n-gen' });

    expect(createGeneration).toHaveBeenCalledWith(
      's1',
      'u1',
      'video',
      '一只柯基',
      ['ver-ref'],
      { channel: undefined, model: undefined, params: undefined },
    );
  });
});
