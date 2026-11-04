import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  buildPreviewInjection,
  INSPECT_TOOL,
  PREVIEW_TOOL,
} from './preview-injection';

const toolMsg = (id: string, artifact: unknown, name = PREVIEW_TOOL) =>
  new ToolMessage({
    content: '已渲染',
    tool_call_id: id,
    name,
    artifact,
  });

describe('buildPreviewInjection', () => {
  it('把预览 artifact 补成一条带图片的用户消息', () => {
    const update = buildPreviewInjection({
      messages: [
        new HumanMessage('做张海报'),
        new AIMessage('好'),
        toolMsg('call_1', { previewPng: 'AAAA' }),
      ],
    });
    expect(update?.messages).toHaveLength(1);
    const injected = update?.messages[0];
    expect(injected?.id).toBe('design-preview-call_1');
    expect(JSON.stringify(injected?.content)).toContain(
      'data:image/png;base64,AAAA',
    );
  });

  it('已补过的不重复补；没有图的工具结果忽略', () => {
    const first = buildPreviewInjection({
      messages: [toolMsg('call_1', { previewPng: 'AAAA' })],
    });
    const again = buildPreviewInjection({
      messages: [
        toolMsg('call_1', { previewPng: 'AAAA' }),
        ...(first?.messages ?? []),
        toolMsg('call_2', undefined),
      ],
    });
    expect(again).toBeUndefined();
  });

  it('inspect_layers 的总览图同样补成用户消息；其它工具的 artifact 不补', () => {
    const update = buildPreviewInjection({
      messages: [
        toolMsg('call_3', { previewPng: 'BBBB' }, INSPECT_TOOL),
        toolMsg('call_4', { previewPng: 'CCCC' }, 'get_document'),
      ],
    });
    expect(update?.messages).toHaveLength(1);
    const text = JSON.stringify(update?.messages[0]?.content);
    expect(text).toContain('inspect_layers');
    expect(text).toContain('BBBB');
  });
});
