import { describe, expect, it } from 'vitest';
import { parseCanvasResult } from './tool-result';

describe('画布工具结果 → 卡片', () => {
  it('create_canvas / open_canvas 的成功结果出卡片；报错结果不出', () => {
    expect(parseCanvasResult('{"canvasId":"c1","title":"海报","opened":true}')).toEqual({
      canvasId: 'c1',
      title: '海报',
      opened: true,
    });
    expect(parseCanvasResult({ canvasId: 'c2', title: '视频', nodes: 3, opened: true })).toMatchObject({ nodes: 3 });
    expect(parseCanvasResult('{"error":"当前对话还没有打开画布"}')).toBeNull();
    expect(parseCanvasResult('not json')).toBeNull();
  });
});
