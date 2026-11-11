import { designEvent } from './design-events';

describe('designEvent（设计 agent 的事件改写）', () => {
  it('tool_end：内容块里的图换成占位、文本块保留；字符串内容原样', () => {
    expect(
      designEvent({
        type: 'tool_end',
        payload: {
          name: 'render_preview',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: '已渲染' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAA' },
            },
          ],
        },
      }),
    ).toEqual({
      type: 'tool_end',
      payload: {
        name: 'render_preview',
        toolCallId: 'c1',
        content: '已渲染\n[预览图]',
      },
    });
    const plain = {
      type: 'tool_end' as const,
      payload: { name: 'get_document', content: '文档摘要' },
    };
    expect(designEvent(plain)).toEqual(plain);
  });

  it('其它事件原样放行（tool_start 的回显去重在 core 里）', () => {
    const start = {
      type: 'tool_start' as const,
      payload: { tool_calls: [{ name: 'add_layers', args: {} }] },
    };
    expect(designEvent(start)).toBe(start);
  });
});
