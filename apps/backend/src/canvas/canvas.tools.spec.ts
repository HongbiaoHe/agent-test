import type { CanvasService } from './canvas.service';
import type { MediaService } from '../media/media.service';
import { createCanvasTools } from './canvas.tools';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';

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

    const out = await addNode!.invoke({ type: 'image_gen', prompt: '正文' });

    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({
        op: 'add_node',
        type: 'image_gen',
        prompt: '正文',
      }),
    );
    expect(JSON.parse(out)).toMatchObject({ revision: 7 });
  });

  it('type 值非法：回一句话而不是抛异常（抛出去会把堆栈灌进对话历史、废掉一整轮）', async () => {
    // 越过 TS 的静态检查喂一个不存在的类型：这正是运行期要拦的那类输入
    const bad = { type: 'audio_gen' } as unknown as { type: 'image_gen' };
    const out = await addNode!.invoke(bad);
    expect(applyOp).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain('audio_gen');
    expect(parsed.error).toContain('video_concat');
  });

  /**
   * 老会话的 checkpoint 里存着模型当初 add_node type:"text" 的调用记录，续跑时它很可能
   * 照着自己的历史再发一次。这条锁住的是「回的话要能照做」——只说非法没用，得说清现在怎么办。
   */
  it('已下线的 text 类型：回一句能照做的指引，指向生成节点的 prompt', async () => {
    const retired = { type: 'text' } as unknown as { type: 'image_gen' };
    const out = await addNode!.invoke(retired);
    expect(applyOp).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain('prompt');
    expect(parsed.error).toContain('image_gen');
  });
});

/**
 * generate_media_node 用**节点上选定的模型**。
 *
 * agent 不参与选模型（它只决定"什么时候生成"），所以这里锁住两件事：
 * 节点配了模型就照配的传下去，没配就把三个字段都留空、由 MediaService 回落默认模型。
 * 提示词取节点自己的 prompt、参考图取自上游 image_gen，与用户手动触发共用同一段逻辑，
 * 这两个用例同时覆盖它。
 */
/**
 * add_node 挂用户附件（versionId）：只认本画布本人已发出的上传版本，类型要与节点对得上；
 * 不对时回一句能照做的话（该用哪种节点 / versionId 从哪来），且不建节点。
 */
describe('add_node 挂附件', () => {
  const applyOp = jest.fn();
  const findUploadedAsset = jest.fn();
  const tools = createCanvasTools(
    // cast-at-injection：只用到 applyOp / findUploadedAsset
    { applyOp } as unknown as CanvasService,
    { findUploadedAsset } as unknown as MediaService,
    { sessionId: 's1', userId: 'u1' },
  );
  const addNode = tools.find((t) => t.name === 'add_node');

  beforeEach(() => {
    applyOp.mockReset();
    findUploadedAsset.mockReset();
  });

  it('类型对得上：建节点时挂上 generation，标题缺省用文件名', async () => {
    findUploadedAsset.mockResolvedValue({
      generationId: 'g-1',
      type: 'audio',
      filename: 'voice.mp3',
    });
    applyOp.mockResolvedValue({
      patch: { op: 'add_node', node: { id: 'cmtjabc123456' } },
      revision: 3,
    });

    await addNode!.invoke({ type: 'audio_upload', versionId: 'v-1' });

    expect(findUploadedAsset).toHaveBeenCalledWith('s1', 'u1', 'v-1');
    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({
        op: 'add_node',
        type: 'audio_upload',
        mediaGenerationId: 'g-1',
        label: 'voice.mp3',
      }),
    );
  });

  it('附件类型与节点不符：指出该用哪种节点，不建节点', async () => {
    findUploadedAsset.mockResolvedValue({
      generationId: 'g-1',
      type: 'video',
      filename: 'clip.mp4',
    });
    const out = await addNode!.invoke({
      type: 'image_upload',
      versionId: 'v-1',
    });
    expect(applyOp).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error?: string }).error).toContain(
      'video_upload',
    );
  });

  it('找不到附件（别的画布 / 还没发出 / 编的 id）：不建节点', async () => {
    findUploadedAsset.mockResolvedValue(null);
    const out = await addNode!.invoke({
      type: 'image_upload',
      versionId: 'v-x',
    });
    expect(applyOp).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error?: string }).error).toContain('[附件]');
  });

  it('versionId 给了非上传节点：不建节点，也不去查附件', async () => {
    const out = await addNode!.invoke({ type: 'image_gen', versionId: 'v-1' });
    expect(applyOp).not.toHaveBeenCalled();
    expect(findUploadedAsset).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error?: string }).error).toContain(
      'image_upload',
    );
  });
});

describe('generate_media_node 的模型来源', () => {
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
      nodes: [refNode, genNode],
      edges: [{ source: 'n-ref', target: genNode.id }],
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
      prompt: '一只柯基',
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
      prompt: '一只柯基',
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

  it('节点没写 prompt → 报错且不触发生成（提示词不再来自上游）', async () => {
    const { tool, createGeneration } = harness({
      id: 'n-gen',
      type: 'image_gen',
      prompt: '   ',
      outputs: [],
    });

    const out = await tool.invoke({ nodeId: 'n-gen' });

    expect(createGeneration).not.toHaveBeenCalled();
    const parsed = JSON.parse(out) as { error?: string };
    expect(parsed.error).toContain('prompt');
  });
});

/**
 * set_node_model：agent 给生成节点设模型 / 档位。校验交给 MediaService.prepareNodeConfig，
 * 这里锁住工具层的几件事——传进去的参考素材计数、不传 model 时沿用节点现有模型、
 * 合法才落 update_node、不合法回 issues 不落库、非生成节点直接拒。
 */
describe('set_node_model', () => {
  const upstream = [
    {
      id: 'n-img',
      type: 'image_upload',
      outputs: [{ type: 'image', content: 'v-img' }],
    },
    {
      id: 'n-aud',
      type: 'audio_upload',
      outputs: [{ type: 'audio', content: 'v-aud' }],
    },
  ];

  function harness(target: Record<string, unknown>) {
    const applyOp = jest.fn().mockResolvedValue({ revision: 9 });
    const prepareNodeConfig = jest.fn();
    const tools = createCanvasTools(
      // cast-at-injection：只用到这几个方法
      {
        applyOp,
        resolveNodeId: jest.fn().mockResolvedValue(target.id),
        agentSnapshot: jest.fn().mockResolvedValue({
          nodes: [...upstream, target],
          edges: upstream.map((n) => ({ source: n.id, target: target.id })),
        }),
      } as unknown as CanvasService,
      { prepareNodeConfig } as unknown as MediaService,
      { sessionId: 's1', userId: 'u1' },
    );
    return {
      tool: tools.find((t) => t.name === 'set_node_model')!,
      applyOp,
      prepareNodeConfig,
    };
  }

  const videoNode = {
    id: 'n-vid',
    type: 'video_gen',
    outputs: [],
    mediaChannel: 'byteplus',
    mediaModel: 'seedance-1.5-pro',
    mediaParams: {},
  };

  it('合法：落 update_node 三个字段，并回报模型收不下的上游素材', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness(videoNode);
    prepareNodeConfig.mockResolvedValue({
      ok: true,
      config: {
        channel: 'byteplus',
        model: 'seedance-2',
        params: { aspect_ratio: '16:9' },
      },
      dropped: { image: 0, video: 0, audio: 1 },
    });

    const out = await tool.invoke({
      nodeId: 'n-vid',
      model: 'seedance 2.0',
      params: { aspect_ratio: '16:9' },
    });

    expect(prepareNodeConfig).toHaveBeenCalledWith('video', {
      model: 'seedance 2.0',
      channel: undefined,
      params: { aspect_ratio: '16:9' },
      referenceCounts: { image: 1, video: 0, audio: 1 },
    });
    expect(applyOp).toHaveBeenCalledWith('s1', 'agent', {
      op: 'update_node',
      nodeId: 'n-vid',
      mediaChannel: 'byteplus',
      mediaModel: 'seedance-2',
      mediaParams: { aspect_ratio: '16:9' },
    });
    expect(JSON.parse(out)).toMatchObject({
      ok: true,
      model: 'seedance-2',
      droppedInputs: { audio: 1 },
    });
  });

  it('不传 model：沿用节点现有模型与渠道，只改档位', async () => {
    const { tool, prepareNodeConfig } = harness(videoNode);
    prepareNodeConfig.mockResolvedValue({ ok: false, issues: [] });

    await tool.invoke({ nodeId: 'n-vid', params: { aspect_ratio: '9:16' } });

    expect(prepareNodeConfig).toHaveBeenCalledWith(
      'video',
      expect.objectContaining({
        model: 'seedance-1.5-pro',
        channel: 'byteplus',
      }),
    );
  });

  it('不合法：回 issues，不落库', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness(videoNode);
    prepareNodeConfig.mockResolvedValue({
      ok: false,
      issues: [{ field: 'params.aspect_ratio', value: '4:3', message: 'x' }],
    });

    const out = await tool.invoke({
      nodeId: 'n-vid',
      params: { aspect_ratio: '4:3' },
    });

    expect(applyOp).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ error: 'invalid_params' });
  });

  it('不是生成节点：直接拒，不去校验', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness({
      id: 'n-cat',
      type: 'video_concat',
      outputs: [],
    });

    const out = await tool.invoke({ nodeId: 'n-cat', model: 'seedance-2' });

    expect(prepareNodeConfig).not.toHaveBeenCalled();
    expect(applyOp).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error?: string }).error).toContain(
      'image_gen',
    );
  });
});

/**
 * add_node 建生成节点时就定模型与档位：校验同 set_node_model（参考素材按 0 算，节点刚建还没入边），
 * 合法才建、并把三个字段随 add_node 一起落；不合法一个节点都不建。
 */
describe('add_node 建时定模型', () => {
  function harness() {
    const applyOp = jest.fn().mockResolvedValue({
      patch: { op: 'add_node', node: { id: 'cmtjabc123456' } },
      revision: 4,
    });
    const prepareNodeConfig = jest.fn();
    const tools = createCanvasTools(
      // cast-at-injection：只用到这两个方法
      { applyOp } as unknown as CanvasService,
      { prepareNodeConfig } as unknown as MediaService,
      { sessionId: 's1', userId: 'u1' },
    );
    return {
      tool: tools.find((t) => t.name === 'add_node')!,
      applyOp,
      prepareNodeConfig,
    };
  }

  it('合法：模型与档位随 add_node 一起落，返回值里带上最终档位', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness();
    prepareNodeConfig.mockResolvedValue({
      ok: true,
      config: {
        channel: 'byteplus',
        model: 'seedance-2',
        params: { aspect_ratio: '9:16', duration: '5', resolution: '720p' },
      },
      dropped: { image: 0, video: 0, audio: 0 },
    });

    const out = await tool.invoke({
      type: 'video_gen',
      prompt: '镜头 1',
      model: 'Seedance 2.0',
      params: { aspect_ratio: '9:16', duration: '5', resolution: '720p' },
    });

    expect(prepareNodeConfig).toHaveBeenCalledWith('video', {
      model: 'Seedance 2.0',
      channel: undefined,
      params: { aspect_ratio: '9:16', duration: '5', resolution: '720p' },
      referenceCounts: { image: 0, video: 0, audio: 0 },
    });
    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({
        op: 'add_node',
        type: 'video_gen',
        mediaChannel: 'byteplus',
        mediaModel: 'seedance-2',
        mediaParams: {
          aspect_ratio: '9:16',
          duration: '5',
          resolution: '720p',
        },
      }),
    );
    expect(JSON.parse(out)).toMatchObject({
      model: 'seedance-2',
      params: { aspect_ratio: '9:16' },
    });
  });

  it('不合法：回 issues，节点不建', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness();
    prepareNodeConfig.mockResolvedValue({
      ok: false,
      issues: [{ field: 'params.aspect_ratio', value: '2:1', message: 'x' }],
    });

    const out = await tool.invoke({
      type: 'video_gen',
      params: { aspect_ratio: '2:1' },
    });

    expect(applyOp).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ error: 'invalid_params' });
  });

  it('非生成节点带 model：拒绝，不校验也不建', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness();

    const out = await tool.invoke({
      type: 'video_concat',
      model: 'seedance-2',
    });

    expect(prepareNodeConfig).not.toHaveBeenCalled();
    expect(applyOp).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error?: string }).error).toContain(
      'image_gen',
    );
  });

  it('不带 model / params：照旧建节点，不去校验', async () => {
    const { tool, applyOp, prepareNodeConfig } = harness();

    await tool.invoke({ type: 'image_gen', prompt: 'x' });

    expect(prepareNodeConfig).not.toHaveBeenCalled();
    expect(applyOp).toHaveBeenCalledWith(
      's1',
      'agent',
      expect.objectContaining({
        mediaModel: undefined,
        mediaParams: undefined,
      }),
    );
  });
});

/**
 * generate_media_node × 测试模式：画布没开 Mock 时，上游是模拟产物要先点名拦下（不触发生成）；
 * 开着 Mock 则照常交给 MediaService（它按触发时的开关记 mock）。业务拒绝回一句话，不抛异常。
 */
describe('generate_media_node 与测试模式', () => {
  const upstream = {
    id: 'cmup000kfmock1',
    type: 'image_gen',
    label: '关键帧1',
    mediaMock: true,
    outputs: [{ type: 'image', content: 'v-up' }],
  };
  const target = {
    id: 'cmvid00target',
    type: 'video_gen',
    prompt: '镜头 1',
    outputs: [],
    mediaChannel: null,
    mediaModel: null,
    mediaParams: null,
  };

  function harness(mockMedia: boolean) {
    const applyOp = jest.fn().mockResolvedValue({ revision: 1 });
    const createGeneration = jest
      .fn()
      .mockResolvedValue({ generationId: 'g-1', versionId: 'v-1' });
    const tools = createCanvasTools(
      // cast-at-injection：只用到这几个方法
      {
        applyOp,
        resolveNodeId: jest.fn().mockResolvedValue(target.id),
        agentSnapshot: jest.fn().mockResolvedValue({
          mockMedia,
          nodes: [upstream, target],
          edges: [{ source: upstream.id, target: target.id }],
        }),
      } as unknown as CanvasService,
      { createGeneration } as unknown as MediaService,
      { sessionId: 's1', userId: 'u1' },
    );
    return {
      tool: tools.find((t) => t.name === 'generate_media_node')!,
      createGeneration,
      applyOp,
    };
  }

  it('没开 Mock、上游是模拟产物：点名上游并拒绝，不触发生成', async () => {
    const { tool, createGeneration, applyOp } = harness(false);
    const out = await tool.invoke({ nodeId: target.id });
    expect(createGeneration).not.toHaveBeenCalled();
    expect(applyOp).not.toHaveBeenCalled();
    const { error } = JSON.parse(out) as { error: string };
    expect(error).toContain('关键帧1');
    expect(error).toContain('mock1');
  });

  it('开着 Mock：照常触发（是否模拟由 MediaService 按触发时的开关定）', async () => {
    const { tool, createGeneration } = harness(true);
    await tool.invoke({ nodeId: target.id });
    expect(createGeneration).toHaveBeenCalled();
  });

  it('业务拒绝（如环境禁用了测试模式）：回一句话而不是抛异常', async () => {
    const { tool, createGeneration } = harness(true);
    createGeneration.mockRejectedValue(
      new BusinessException(ErrorCodes.CANVAS_MOCK_DISABLED),
    );
    const out = await tool.invoke({ nodeId: target.id });
    expect(JSON.parse(out)).toMatchObject({
      error: { code: ErrorCodes.CANVAS_MOCK_DISABLED.code },
    });
  });
});

/**
 * 上游依赖：画布上一口气触发整条链时，在途（排队 / 生成中）的上游带上它的版本让下游等，
 * 没触发过的上游直接拒绝——否则下游会少带一路参考就开跑（Mock 验收里实际撞到过）。
 */
describe('generate_media_node / merge_video_node 的上游依赖', () => {
  const inFlight = {
    id: 'cmimg00flight',
    type: 'image_gen',
    label: '关键帧',
    mediaMock: false,
    mediaVersionId: 'v-flight',
    mediaStatus: 'generating',
    outputs: [],
  };
  const never = {
    id: 'cmimg000never',
    type: 'image_gen',
    label: '没触发',
    mediaMock: false,
    mediaVersionId: null,
    mediaStatus: null,
    outputs: [],
  };
  const videoGen = {
    id: 'cmvid00target',
    type: 'video_gen',
    prompt: '镜头 1',
    outputs: [],
    mediaChannel: null,
    mediaModel: null,
    mediaParams: null,
  };
  const clipDone = {
    id: 'cmclip00done1',
    type: 'video_gen',
    label: '片段1',
    mediaMock: false,
    mediaVersionId: 'v-c1',
    mediaStatus: 'done',
    outputs: [{ type: 'video', content: 'v-c1' }],
  };
  const clipQueued = {
    id: 'cmclip0queue2',
    type: 'video_gen',
    label: '片段2',
    mediaMock: false,
    mediaVersionId: 'v-c2',
    mediaStatus: 'queued',
    outputs: [],
  };
  const clipNever = {
    ...never,
    id: 'cmclip0never3',
    type: 'video_gen',
    label: '片段3',
  };
  const concat = { id: 'cmconcat00tgt', type: 'video_concat', outputs: [] };

  function harness(
    nodes: Record<string, unknown>[],
    edges: { source: string; target: string }[],
    targetId: string,
  ) {
    const applyOp = jest.fn().mockResolvedValue({ revision: 1 });
    const createGeneration = jest
      .fn()
      .mockResolvedValue({ generationId: 'g-1', versionId: 'v-1' });
    const createConcat = jest
      .fn()
      .mockResolvedValue({ generationId: 'g-2', versionId: 'v-2' });
    const tools = createCanvasTools(
      // cast-at-injection：只用到这几个方法
      {
        applyOp,
        resolveNodeId: jest.fn().mockResolvedValue(targetId),
        agentSnapshot: jest
          .fn()
          .mockResolvedValue({ mockMedia: false, nodes, edges }),
      } as unknown as CanvasService,
      { createGeneration, createConcat } as unknown as MediaService,
      { sessionId: 's1', userId: 'u1' },
    );
    return {
      generate: tools.find((t) => t.name === 'generate_media_node')!,
      merge: tools.find((t) => t.name === 'merge_video_node')!,
      createGeneration,
      createConcat,
      applyOp,
    };
  }

  it('上游在生成中：带上它的版本照常触发，并回报 pendingInputs', async () => {
    const h = harness(
      [inFlight, videoGen],
      [{ source: inFlight.id, target: videoGen.id }],
      videoGen.id,
    );
    const out = await h.generate.invoke({ nodeId: videoGen.id });
    expect(h.createGeneration).toHaveBeenCalledWith(
      's1',
      'u1',
      'video',
      '镜头 1',
      ['v-flight'],
      expect.anything(),
    );
    expect(JSON.parse(out)).toMatchObject({ references: 1, pendingInputs: 1 });
  });

  it('上游没触发过：点名拒绝，不触发也不落 op', async () => {
    const h = harness(
      [inFlight, never, videoGen],
      [
        { source: inFlight.id, target: videoGen.id },
        { source: never.id, target: videoGen.id },
      ],
      videoGen.id,
    );
    const out = await h.generate.invoke({ nodeId: videoGen.id });
    expect(h.createGeneration).not.toHaveBeenCalled();
    expect(h.applyOp).not.toHaveBeenCalled();
    const { error } = JSON.parse(out) as { error: string };
    expect(error).toContain('没触发');
    expect(error).toContain('0never');
  });

  it('拼接：已完成 + 排队中的片段按入边顺序提交，回报 pendingClips', async () => {
    const h = harness(
      [clipQueued, clipDone, concat],
      [
        { source: clipQueued.id, target: concat.id },
        { source: clipDone.id, target: concat.id },
      ],
      concat.id,
    );
    const out = await h.merge.invoke({ nodeId: concat.id });
    expect(h.createConcat).toHaveBeenCalledWith('s1', 'u1', ['v-c2', 'v-c1']);
    expect(JSON.parse(out)).toMatchObject({ clips: 2, pendingClips: 1 });
  });

  it('拼接：有片段没触发过 → 点名拒绝，不拼', async () => {
    const h = harness(
      [clipDone, clipQueued, clipNever, concat],
      [
        { source: clipDone.id, target: concat.id },
        { source: clipQueued.id, target: concat.id },
        { source: clipNever.id, target: concat.id },
      ],
      concat.id,
    );
    const out = await h.merge.invoke({ nodeId: concat.id });
    expect(h.createConcat).not.toHaveBeenCalled();
    expect((JSON.parse(out) as { error: string }).error).toContain('片段3');
  });
});
