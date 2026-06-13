import {
  isAIMessage,
  isBaseMessage,
  isToolMessage,
} from '@langchain/core/messages';
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
 *
 * data 来自 LangGraph 流，运行时是真实的 LangChain 消息实例，故用官方类型守卫
 * （isBaseMessage/isAIMessage/isToolMessage）与 BaseMessage.text getter 强类型解析，
 * 不自定义结构体、不逐字段断言。
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

function normalizeMessage(data: unknown): RawEvent | null {
  // messages 模式产出 [message, metadata] 元组，取首元素为消息本体。
  const msg = Array.isArray(data) ? (data as unknown[])[0] : data;
  if (!isBaseMessage(msg)) return null;
  if (isToolMessage(msg)) {
    return {
      type: 'tool_end',
      payload: { name: msg.name, content: msg.content, status: msg.status },
    };
  }
  if (isAIMessage(msg)) {
    return msg.text ? { type: 'token', payload: { text: msg.text } } : null;
  }
  return null;
}

/** updates 模式下单个节点的最小形状（messages 元素是消息实例，故声明为 unknown[] 交给守卫收窄）。 */
interface UpdateNode {
  todos?: unknown[];
  messages?: unknown[];
}

function normalizeUpdate(data: unknown): RawEvent | null {
  if (!data || typeof data !== 'object') return null;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const node = value as UpdateNode;

    if (Array.isArray(node.todos)) {
      return { type: 'plan_update', payload: { todos: node.todos } };
    }

    if (Array.isArray(node.messages) && node.messages.length) {
      const last = node.messages[node.messages.length - 1];
      if (isBaseMessage(last) && isAIMessage(last)) {
        if (last.tool_calls && last.tool_calls.length) {
          return {
            type: 'tool_start',
            payload: {
              tool_calls: last.tool_calls.map((c) => ({
                name: c.name,
                args: c.args,
              })),
            },
          };
        }
        if (last.text) return { type: 'message', payload: { text: last.text } };
      }
    }
  }
  return null;
}
