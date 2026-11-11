import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';

/**
 * 设计专属的事件改写（consumeAgentStream 的 mapEvent）：render_preview / inspect_layers 的结果里有
 * 整张 base64 图，tool_end 推流与落库前换成占位（图只给模型看）。tool_start 的回显去重在 core 里做。
 */
export function designEvent(evt: RawEvent): RawEvent {
  if (evt.type === 'tool_end') {
    return { type: 'tool_end', payload: stripImages(evt.payload) };
  }
  return evt;
}

/** tool_end.content 若是内容块数组，把图片块换成文字占位。 */
function stripImages(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('content' in payload))
    return payload;
  const content = payload.content;
  if (!Array.isArray(content)) return payload;
  return {
    ...payload,
    content: content
      .map((b: unknown) =>
        b &&
        typeof b === 'object' &&
        'type' in b &&
        b.type === 'text' &&
        'text' in b
          ? String(b.text)
          : '[预览图]',
      )
      .join('\n'),
  };
}
