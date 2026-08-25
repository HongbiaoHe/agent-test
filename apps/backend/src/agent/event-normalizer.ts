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
 *  - messages + AIMessageChunk(思考) → reasoning
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
    // 思考与正文不在同一个 chunk 里（实测：deepseek 推理阶段 content 为空、正文阶段不再带
    // reasoning_content；Gemini 的 thinking 块与 text 块也是分开的 chunk）。
    const reasoning = reasoningText(msg);
    if (reasoning) return { type: 'reasoning', payload: { text: reasoning } };
    return msg.text ? { type: 'token', payload: { text: msg.text } } : null;
  }
  return null;
}

/** Gemini 的思考块：`{ type: 'thinking', thinking: '...' }`（正文在 thinking 字段，不是 text）。 */
function isThinkingBlock(block: unknown): block is { thinking: string } {
  return (
    !!block &&
    typeof block === 'object' &&
    'thinking' in block &&
    typeof block.thinking === 'string'
  );
}

/**
 * 取一块思考增量。`reasoning` 在 @langchain/core 1.1.48 里还不是一等字段
 * （message.d.ts 只在示例里提到 reasoning content block），两家落点完全不同，都要吃：
 *
 * - DeepSeek：`additional_kwargs.reasoning_content`（实测 deepseek-reasoner / v4-flash / v4-pro）
 * - Gemini：`content` 数组里的 `{ type: 'thinking', thinking: '...' }` 块（实测 gemini-3.5-flash
 *   开启 thinkingConfig.includeThoughts 后，流式与非流式都给）。注意**不能**用 `msg.text` 取 ——
 *   那个 getter 只拼 text 块，思考块会被它无声丢掉。
 *
 * 拿不到就返回空串：非推理模型没有思考流，功能自动降级为不显示。
 */
function reasoningText(msg: {
  additional_kwargs?: Record<string, unknown>;
  content?: unknown;
}): string {
  const deepseek = msg.additional_kwargs?.reasoning_content;
  if (typeof deepseek === 'string' && deepseek) return deepseek;
  if (!Array.isArray(msg.content)) return '';
  let out = '';
  for (const block of msg.content) {
    if (isThinkingBlock(block)) out += block.thinking;
  }
  return out;
}

/**
 * 从 updates 节点更新里抽取 **Gemini 的思考正文**，按 message id 去重。
 *
 * 为什么非得走 updates：langgraph 的 `messages` 流会把 AIMessageChunk 的 content 压成 string，
 * thinking 块在到达 normalize 之前就没了（实测一整轮 canvas run，全部 chunk 都是
 * `contentType: "string"` 且 additional_kwargs 为空）。updates 给的是 state 里的完整
 * AIMessage，content 保持原样，思考才拿得到。代价是非流式：整段思考一次性给出。
 *
 * 刻意**只取 thinking 块**、不碰 `reasoning_content`：DeepSeek 那条已由 messages 流逐块推送，
 * 这里再取一遍会把同一段思考落两份。
 */
export function extractThinkingBlocks(
  data: unknown,
  seen: Set<string>,
): string[] {
  const out: string[] = [];
  if (!data || typeof data !== 'object') return out;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const msgs = (value as { messages?: unknown[] }).messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!isBaseMessage(m) || !isAIMessage(m)) continue;
      if (!Array.isArray(m.content)) continue;
      let text = '';
      for (const block of m.content) {
        if (isThinkingBlock(block)) text += block.thinking;
      }
      if (!text) continue;
      const id = m.id ?? '';
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(text);
    }
  }
  return out;
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
