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

  it('接受视频类上游，拒绝文本/图片', () => {
    expect(canConnectNodeTypes('video_gen', 'video_concat')).toBe(true);
    // 拼接结果本身也是视频，可以再接一层
    expect(canConnectNodeTypes('video_concat', 'video_concat')).toBe(true);
    expect(canConnectNodeTypes('text', 'video_concat')).toBe(false);
    expect(canConnectNodeTypes('image_gen', 'video_concat')).toBe(false);
    expect(canConnectNodeTypes('image_upload', 'video_concat')).toBe(false);
  });

  it('拼接产物可继续喂给生视频节点', () => {
    expect(canConnectNodeTypes('video_concat', 'video_gen')).toBe(true);
  });
});

describe('collectVideoSources', () => {
  const nodes = [
    { id: 'a', outputs: [{ type: 'video' as const, content: 'va' }] },
    { id: 'b', outputs: [{ type: 'video' as const, content: 'vb' }] },
    { id: 't', outputs: [{ type: 'text' as const, content: 'hi' }] },
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

  it('只取 video 输出，忽略文本与尚未就绪的上游', () => {
    const edges = [
      { source: 't', target: 'c' },
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
