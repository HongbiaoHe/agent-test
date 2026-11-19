import {
  isAIMessage,
  isBaseMessage,
  isToolMessage,
  type ToolMessage,
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
 *  - updates  + ToolMessage          → tool_end（Command 返回的结果只在这里，如 task）
 * namespace 不在这里解释：子 agent 归属由 consumeAgentStream 按 namespace 判定。
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
  if (isToolMessage(msg)) return toolEnd(msg);
  if (isAIMessage(msg)) {
    // 思考与正文不在同一个 chunk 里（实测：deepseek 推理阶段 content 为空、正文阶段不再带
    // reasoning_content；Gemini 的 thinking 块与 text 块也是分开的 chunk）。
    const reasoning = reasoningText(msg);
    // 带上源消息 id：思考是**那条 AIMessage 的一部分**，不是一个独立发生的事件。
    // 下游据此把同一条消息的多次增量归并成一块，也据此识别 checkpoint 重放的旧思考。
    if (reasoning) {
      return {
        type: 'reasoning',
        payload: { text: reasoning, sourceId: msg.id ?? '' },
      };
    }
    return msg.text ? { type: 'token', payload: { text: msg.text } } : null;
  }
  return null;
}

function toolEnd(msg: ToolMessage): RawEvent {
  return {
    type: 'tool_end',
    // toolCallId：前端据此与对应的 tool_start 配对（同名工具并发 / 审批续跑重发时按名字配不准）
    payload: {
      name: msg.name,
      content: msg.content,
      status: msg.status,
      toolCallId: msg.tool_call_id,
      // MCP 工具的 App 卡片数据 / 需重新授权提示（见 mcp-agent-tools）：随 tool_end 落库，刷新可重建卡片。
      // 只透出这两个约定字段，其它工具的 artifact 不进事件（可能很大且前端用不到）。
      ...mcpArtifactFields(msg.artifact),
    },
  };
}

function mcpArtifactFields(artifact: unknown): Record<string, unknown> {
  if (!artifact || typeof artifact !== 'object') return {};
  const out: Record<string, unknown> = {};
  if ('mcpApp' in artifact && artifact.mcpApp) out.mcpApp = artifact.mcpApp;
  if ('mcpAuthRequired' in artifact && artifact.mcpAuthRequired) {
    out.mcpAuthRequired = artifact.mcpAuthRequired;
  }
  return out;
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
 * （message.d.ts 只在示例里提到 reasoning content block），各家落点完全不同，都要吃：
 *
 * - DeepSeek：`additional_kwargs.reasoning_content`（实测 deepseek-reasoner / v4-flash / v4-pro）
 * - OpenAI（Responses API）：`content` 数组里的 `{ type: 'reasoning', reasoning: '...' }` 摘要块
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
  return thinkingText(msg.content) || openaiReasoningText(msg.content);
}

/** OpenAI Responses API 的思考摘要块：`{ type: 'reasoning', reasoning: '...' }`（@langchain/openai 的转换结果） */
function isOpenAIReasoningBlock(
  block: unknown,
): block is { type: 'reasoning'; reasoning: string } {
  return (
    !!block &&
    typeof block === 'object' &&
    'type' in block &&
    block.type === 'reasoning' &&
    'reasoning' in block &&
    typeof block.reasoning === 'string'
  );
}

/**
 * 消息 content 里 OpenAI 思考摘要块的正文拼接。与 Gemini 的 thinkingText 分开：OpenAI 的块在 messages
 * 流里原样保留（流式逐段给），Gemini 的块在那里会被压掉、要靠 thinking-tap 实时取——混在一个函数里，
 * thinking-tap 会把 OpenAI 的增量再累加一遍。
 */
export function openaiReasoningText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const blocks: unknown[] = content;
  let out = '';
  for (const block of blocks) {
    if (isOpenAIReasoningBlock(block)) out += block.reasoning;
  }
  return out;
}

/** 消息 content 里 Gemini 思考块（`{ type: 'thinking', thinking }`）的正文拼接；不是数组或没有思考块返回空串 */
export function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const blocks: unknown[] = content;
  let out = '';
  for (const block of blocks) {
    if (isThinkingBlock(block)) out += block.thinking;
  }
  return out;
}

/** 一块思考及其归属的源消息 id（id 可能为空：provider 没给时退化成按正文去重）。 */
export interface ThinkingPart {
  id: string;
  text: string;
}

/**
 * 从 updates 节点更新里抽取 **Gemini / OpenAI 内容块里的思考正文**，连同它归属的 AIMessage id 一起给出。
 *
 * 为什么非得走 updates：langgraph 的 `messages` 流会把 AIMessageChunk 的 content 压成 string，
 * thinking 块在到达 normalize 之前就没了（实测一整轮 canvas run，全部 chunk 都是
 * `contentType: "string"` 且 additional_kwargs 为空）。updates 给的是 state 里的完整
 * AIMessage，content 保持原样，思考才拿得到。代价是非流式：整段思考一次性给出。
 *
 * 刻意**只取 thinking 块**、不碰 `reasoning_content`：DeepSeek 那条已由 messages 流逐块推送，
 * 这里再取一遍会把同一段思考落两份。
 *
 * **不在这里去重**：本函数只认「这次更新里有哪些思考」。哪些该丢，取决于调用方才知道的上下文
 * ——同一轮内跨节点的回显要合并，而 checkpoint 重放的**上几轮**消息要整条丢掉。把两种判断混进
 * 一个 `seen` 集合正是之前那个 bug：集合每轮新建，拦得住同轮回显，拦不住跨轮重放，于是旧思考
 * 每轮被当成新事件重发一遍（换了模型也照发，因为它来自 checkpoint 而不是本次调用）。
 */
export function extractThinkingBlocks(data: unknown): ThinkingPart[] {
  const out: ThinkingPart[] = [];
  if (!data || typeof data !== 'object') return out;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const msgs = (value as { messages?: unknown[] }).messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!isBaseMessage(m) || !isAIMessage(m)) continue;
      // OpenAI 的摘要多数时候已由 messages 流按同一消息 id 逐段推过，这里整块给出会被归集器按 id 挡掉；
      // 模型没走流式时才靠这里补上
      const text = thinkingText(m.content) || openaiReasoningText(m.content);
      if (!text) continue;
      out.push({ id: m.id ?? '', text });
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
      // 工具结果：普通工具在 messages 流里已经给过一次（消费方按 toolCallId 去重）；以 Command 返回结果的
      // 工具（如子 agent 的 task）只出现在 updates 里，不从这里取就永远没有 tool_end
      if (isBaseMessage(last) && isToolMessage(last)) return toolEnd(last);
      if (isBaseMessage(last) && isAIMessage(last)) {
        if (last.tool_calls && last.tool_calls.length) {
          return {
            type: 'tool_start',
            // 带上 tool_call id：审批（HITL）续跑时中间件会把同一条 AIMessage 改写 tool_calls 后再发一次
            // （langchain hitl.js：edit 保留原 id），updates 流里就会出现同一个调用的第二次 tool_start；
            // 前端按 id 合并成一个 chip，否则先出的那个永远等不到 tool_end、一直转圈。
            payload: {
              tool_calls: last.tool_calls.map((c) => ({
                id: c.id,
                name: c.name,
                args: c.args,
              })),
            },
          };
        }
        // sourceId：同一条 AIMessage 会在多个节点回显，消费方据此只收口一次
        if (last.text) {
          return {
            type: 'message',
            payload: { text: last.text, sourceId: last.id ?? '' },
          };
        }
      }
    }
  }
  return null;
}
