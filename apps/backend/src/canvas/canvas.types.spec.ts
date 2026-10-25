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

function node(
  id: string,
  type: CanvasNodeType,
  outputs: CanvasNodeOutput[] = [],
  media: Pick<CanvasNodeDto, 'mediaVersionId' | 'mediaStatus'> = {
    mediaVersionId: null,
    mediaStatus: null,
  },
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
    ...media,
    mediaMock: false,
    outputs,
  };
}

describe('collectGenerationInputs', () => {
  const nodes = [
    node('img', 'image_upload', [{ type: 'image', content: 'v-img' }]),
    node('vid', 'video_upload', [{ type: 'video', content: 'v-vid' }]),
    node('aud', 'audio_upload', [{ type: 'audio', content: 'v-aud' }]),
    node('gen', 'image_gen', [{ type: 'image', content: 'v-gen' }]),
    node('queued', 'image_gen', [], {
      mediaVersionId: 'v-queued',
      mediaStatus: 'queued',
    }),
    node('generating', 'video_gen', [], {
      mediaVersionId: 'v-generating',
      mediaStatus: 'generating',
    }),
    node('never', 'image_gen'),
    node('failed', 'image_gen', [], {
      mediaVersionId: 'v-failed',
      mediaStatus: 'failed',
    }),
    node('paused', 'image_gen', [], {
      mediaVersionId: 'v-paused',
      mediaStatus: 'paused',
    }),
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
      pendingInputs: 0,
      missingInputs: [],
    });
  });

  it('排队 / 生成中的上游带上它的版本（worker 会等），按入边顺序计数', () => {
    const edges = [
      { source: 'queued', target: 'target' },
      { source: 'img', target: 'target' },
      { source: 'generating', target: 'target' },
    ];
    expect(collectGenerationInputs(nodes, edges, 'target')).toEqual({
      referenceVersionIds: ['v-queued', 'v-img', 'v-generating'],
      referenceCounts: { image: 2, video: 1, audio: 0 },
      pendingInputs: 2,
      missingInputs: [],
    });
  });

  it('暂停中的上游也算在途：带上它的版本，继续后照常出', () => {
    const edges = [{ source: 'paused', target: 'target' }];
    expect(collectGenerationInputs(nodes, edges, 'target')).toMatchObject({
      referenceVersionIds: ['v-paused'],
      pendingInputs: 1,
      missingInputs: [],
    });
  });

  it('没触发过 / 失败的上游算缺失（调用方据此拒绝）', () => {
    const edges = [
      { source: 'never', target: 'target' },
      { source: 'img', target: 'target' },
      { source: 'failed', target: 'target' },
    ];
    const inputs = collectGenerationInputs(nodes, edges, 'target');
    expect(inputs.referenceVersionIds).toEqual(['v-img']);
    expect(inputs.missingInputs.map((n) => n.id)).toEqual(['never', 'failed']);
  });

  it('只收目标节点接受的类型（历史遗留的非法边不把视频塞给生图，也不算缺）', () => {
    const edges = [
      { source: 'vid', target: 'img-target' },
      { source: 'generating', target: 'img-target' },
      { source: 'img', target: 'img-target' },
    ];
    expect(collectGenerationInputs(nodes, edges, 'img-target')).toEqual({
      referenceVersionIds: ['v-img'],
      referenceCounts: { image: 1, video: 0, audio: 0 },
      pendingInputs: 0,
      missingInputs: [],
    });
  });
});

describe('collectVideoSources', () => {
  const nodes = [
    node('a', 'video_gen', [{ type: 'video', content: 'va' }]),
    node('b', 'video_gen', [{ type: 'video', content: 'vb' }]),
    node('img', 'image_gen', [{ type: 'image', content: 'ia' }]),
    node('running', 'video_gen', [], {
      mediaVersionId: 'v-running',
      mediaStatus: 'generating',
    }),
    node('concat-queued', 'video_concat', [], {
      mediaVersionId: 'v-concat',
      mediaStatus: 'queued',
    }),
    node('never', 'video_gen'),
    node('c', 'video_concat'),
  ];

  it('按入边顺序取上游视频（顺序决定合成先后，必须稳定）', () => {
    const edges = [
      { source: 'b', target: 'c' },
      { source: 'a', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c')).toEqual({
      sources: ['vb', 'va'],
      pendingSources: 0,
      missingSources: [],
    });
  });

  it('在途的视频 / 拼接带上版本参与排序，worker 等齐再拼', () => {
    const edges = [
      { source: 'running', target: 'c' },
      { source: 'a', target: 'c' },
      { source: 'concat-queued', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c')).toEqual({
      sources: ['v-running', 'va', 'v-concat'],
      pendingSources: 2,
      missingSources: [],
    });
  });

  it('只取 video 输出，图片上游忽略；没触发过的视频算缺失', () => {
    const edges = [
      { source: 'img', target: 'c' },
      { source: 'never', target: 'c' },
      { source: 'a', target: 'c' },
    ];
    const r = collectVideoSources(nodes, edges, 'c');
    expect(r.sources).toEqual(['va']);
    expect(r.missingSources.map((n) => n.id)).toEqual(['never']);
  });

  it('不含指向别的节点的边', () => {
    const edges = [
      { source: 'a', target: 'other' },
      { source: 'b', target: 'c' },
    ];
    expect(collectVideoSources(nodes, edges, 'c').sources).toEqual(['vb']);
  });

  it('没有入边就是空', () => {
    expect(collectVideoSources(nodes, [], 'c')).toEqual({
      sources: [],
      pendingSources: 0,
      missingSources: [],
    });
  });
});
