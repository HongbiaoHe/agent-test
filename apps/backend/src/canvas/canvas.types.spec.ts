import {
  CANVAS_NODE_IO,
  type CanvasNodeDto,
  type CanvasNodeOutput,
  type CanvasNodeType,
  canConnectNodeTypes,
  collectGenerationInputs,
  collectVideoSources,
} from './canvas.types';

describe('video_concat 的端口契约', () => {
  it('只吃视频，产出视频', () => {
    expect(CANVAS_NODE_IO.video_concat).toEqual({
      inputs: ['video'],
      outputs: ['video'],
    });
  });

  it('接受视频类上游，拒绝图片', () => {
    expect(canConnectNodeTypes('video_gen', 'video_concat')).toBe(true);
    // 拼接结果本身也是视频，可以再接一层
    expect(canConnectNodeTypes('video_concat', 'video_concat')).toBe(true);
    expect(canConnectNodeTypes('image_gen', 'video_concat')).toBe(false);
    expect(canConnectNodeTypes('image_upload', 'video_concat')).toBe(false);
  });

  it('拼接产物可继续喂给生视频节点', () => {
    expect(canConnectNodeTypes('video_concat', 'video_gen')).toBe(true);
  });
});

/**
 * text 节点下线后的端口契约：入边只提供参考素材，提示词是生成节点自己的 prompt 字段。
 * 锁住它，免得哪天又把 'text' 加回 inputs、让「提示词靠连线」悄悄复活。
 */
describe('生成节点的端口契约（text 节点下线后）', () => {
  it('入边只收图片/视频/音频，不再有 text 通道', () => {
    expect(CANVAS_NODE_IO.image_gen).toEqual({
      inputs: ['image'],
      outputs: ['image'],
    });
    expect(CANVAS_NODE_IO.video_gen).toEqual({
      inputs: ['image', 'video', 'audio'],
      outputs: ['video'],
    });
  });

  it('上传节点都没有输入端口', () => {
    for (const t of ['image_upload', 'video_upload', 'audio_upload'] as const) {
      expect(CANVAS_NODE_IO[t].inputs).toEqual([]);
      expect(canConnectNodeTypes('image_gen', t)).toBe(false);
    }
  });

  it('图片上游可连到生成节点（参考图）', () => {
    expect(canConnectNodeTypes('image_upload', 'image_gen')).toBe(true);
    expect(canConnectNodeTypes('image_gen', 'video_gen')).toBe(true);
  });
});

describe('上传节点的端口契约', () => {
  it('输出类型随节点固定：图片 / 视频 / 音频', () => {
    expect(CANVAS_NODE_IO.image_upload.outputs).toEqual(['image']);
    expect(CANVAS_NODE_IO.video_upload.outputs).toEqual(['video']);
    expect(CANVAS_NODE_IO.audio_upload.outputs).toEqual(['audio']);
  });

  it('视频 / 音频上传只能喂给收它们的节点', () => {
    expect(canConnectNodeTypes('video_upload', 'video_gen')).toBe(true);
    expect(canConnectNodeTypes('video_upload', 'video_concat')).toBe(true);
    expect(canConnectNodeTypes('video_upload', 'image_gen')).toBe(false);
    expect(canConnectNodeTypes('audio_upload', 'video_gen')).toBe(true);
    expect(canConnectNodeTypes('audio_upload', 'image_gen')).toBe(false);
    expect(canConnectNodeTypes('audio_upload', 'video_concat')).toBe(false);
  });
});

describe('collectGenerationInputs', () => {
  function node(
    id: string,
    type: CanvasNodeType,
    outputs: CanvasNodeOutput[] = [],
  ): CanvasNodeDto {
    return {
      id,
      type,
      x: 0,
      y: 0,
      version: 0,
      label: null,
      prompt: null,
      assetPath: null,
      mediaGenerationId: null,
      mediaChannel: null,
      mediaModel: null,
      mediaParams: null,
      mediaVersionId: null,
      mediaStatus: null,
      outputs,
    };
  }
  const nodes = [
    node('img', 'image_upload', [{ type: 'image', content: 'v-img' }]),
    node('vid', 'video_upload', [{ type: 'video', content: 'v-vid' }]),
    node('aud', 'audio_upload', [{ type: 'audio', content: 'v-aud' }]),
    node('gen', 'image_gen', [{ type: 'image', content: 'v-gen' }]),
    node('pending', 'image_gen'),
    node('target', 'video_gen'),
    node('img-target', 'image_gen'),
  ];

  it('生成的与上传的素材都收，按入边顺序', () => {
    const edges = [
      { source: 'aud', target: 'target' },
      { source: 'gen', target: 'target' },
      { source: 'vid', target: 'target' },
      { source: 'img', target: 'target' },
    ];
    expect(collectGenerationInputs(nodes, edges, 'target')).toEqual({
      referenceVersionIds: ['v-aud', 'v-gen', 'v-vid', 'v-img'],
      referenceCounts: { image: 2, video: 1, audio: 1 },
      waitingInputs: 0,
    });
  });

  it('还没产物的上游不参与，单独计数', () => {
    const edges = [
      { source: 'pending', target: 'target' },
      { source: 'img', target: 'target' },
    ];
    expect(collectGenerationInputs(nodes, edges, 'target')).toEqual({
      referenceVersionIds: ['v-img'],
      referenceCounts: { image: 1, video: 0, audio: 0 },
      waitingInputs: 1,
    });
  });

  it('只收目标节点接受的类型（历史遗留的非法边不把视频塞给生图）', () => {
    const edges = [
      { source: 'vid', target: 'img-target' },
      { source: 'img', target: 'img-target' },
    ];
    expect(collectGenerationInputs(nodes, edges, 'img-target')).toEqual({
      referenceVersionIds: ['v-img'],
      referenceCounts: { image: 1, video: 0, audio: 0 },
      waitingInputs: 0,
    });
  });
});

describe('collectVideoSources', () => {
  const nodes = [
    { id: 'a', outputs: [{ type: 'video' as const, content: 'va' }] },
    { id: 'b', outputs: [{ type: 'video' as const, content: 'vb' }] },
    { id: 'img', outputs: [{ type: 'image' as const, content: 'ia' }] },
    { id: 'empty', outputs: [] },
    { id: 'c', outputs: [] },
  ];

  it('按入边顺序取上游视频（顺序决定合成先后，必须稳定）', () => {
    const edges = [
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c')).toEqual(['vb', 'va']);
  });

  it('只取 video 输出，忽略图片与尚未就绪的上游', () => {
    const edges = [
      { source: 'img', target: 'c' },
      { source: 'empty', target: 'c' },
      { source: 'a', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c')).toEqual(['va']);
  });

  it('不含指向别的节点的边', () => {
    const edges = [
      { source: 'a', target: 'other' },
      { source: 'b', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c')).toEqual(['vb']);
  });

  it('没有入边就是空', () => {
    expect(collectVideoSources(nodes, [], 'c')).toEqual([]);
  });
});
