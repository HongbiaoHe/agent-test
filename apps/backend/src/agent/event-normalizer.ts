import { ConversationEvent } from './types';

/** 未补充 seq/conversationId/ts 的事件（由发布层补全）。 */
export type RawEvent = Pick<ConversationEvent, 'type' | 'payload'>;

/**
 * 把 agent.stream 的 [namespace, mode, data] 元组归一成 RawEvent。
 * 返回 null 表示该事件可忽略（如空的中间件钩子）。
 * 映射依据真实 spike 观察（deepagents 1.10.2 + Gemini）：
 *  - messages + ToolMessage         → tool_end
 *  - messages + AIMessageChunk(文本) → token
 *  - updates  + {node:{todos}}       → plan_update
 *  - updates  + AIMessage(tool_calls)→ tool_start
 *  - updates  + AIMessage(文本)      → message
 */
export function normalize(
  _namespace: string[],
  mode: string,
  data: unknown,
): RawEvent | null {
  if (mode === 'messages') return normalizeMessage(data);
  if (mode === 'updates') return normalizeUpdate(data);
  return null;
}

function getType(msg: any): string {
  if (typeof msg?._getType === 'function') return msg._getType();
  if (typeof msg?.getType === 'function') return msg.getType();
  return '';
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

function normalizeMessage(data: unknown): RawEvent | null {
  const msg: any = Array.isArray(data) ? data[0] : data;
  if (!msg) return null;
  const t = getType(msg);
  if (t === 'tool') {
    return {
      type: 'tool_end',
      payload: { name: msg.name, content: msg.content, status: msg.status },
    };
  }
  if (t === 'ai') {
    const text = textOf(msg.content);
    return text ? { type: 'token', payload: { text } } : null;
  }
  return null;
}

function normalizeUpdate(data: unknown): RawEvent | null {
  if (!data || typeof data !== 'object') return null;
  for (const val of Object.values(data as Record<string, any>)) {
    if (!val || typeof val !== 'object') continue;

    if (Array.isArray(val.todos)) {
      return { type: 'plan_update', payload: { todos: val.todos } };
    }

    if (Array.isArray(val.messages) && val.messages.length) {
      const m: any = val.messages[val.messages.length - 1];
      if (getType(m) === 'ai') {
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          return {
            type: 'tool_start',
            payload: {
              tool_calls: m.tool_calls.map((c: any) => ({
                name: c.name,
                args: c.args,
              })),
            },
          };
        }
        const text = textOf(m.content);
        if (text) return { type: 'message', payload: { text } };
      }
    }
  }
  return null;
}
