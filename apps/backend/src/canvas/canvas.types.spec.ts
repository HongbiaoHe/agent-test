import {
  CANVAS_NODE_IO,
  canConnectNodeTypes,
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
 * text 节点下线后的端口契约：入边只提供参考图，提示词是生成节点自己的 prompt 字段。
 * 锁住它，免得哪天又把 'text' 加回 inputs、让「提示词靠连线」悄悄复活。
 */
describe('生成节点的端口契约（text 节点下线后）', () => {
  it('入边只收图片/视频，不再有 text 通道', () => {
    expect(CANVAS_NODE_IO.image_gen).toEqual({
      inputs: ['image'],
      outputs: ['image'],
    });
    expect(CANVAS_NODE_IO.video_gen).toEqual({
      inputs: ['image', 'video'],
      outputs: ['video'],
    });
  });

  it('image_upload 仍然没有输入端口', () => {
    expect(CANVAS_NODE_IO.image_upload.inputs).toEqual([]);
    expect(canConnectNodeTypes('image_gen', 'image_upload')).toBe(false);
  });

  it('图片上游可连到生成节点（参考图）', () => {
    expect(canConnectNodeTypes('image_upload', 'image_gen')).toBe(true);
    expect(canConnectNodeTypes('image_gen', 'video_gen')).toBe(true);
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
