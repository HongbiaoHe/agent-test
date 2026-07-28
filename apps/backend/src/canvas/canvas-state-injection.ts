import { HumanMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * 实时画布状态注入（纯逻辑，刻意不依赖 deepagents，便于在 jest 里单测；同 agent/plan-injection.ts）。
 *
 * 把最新「节点/连线 + 放置安全区」作为一条新消息**追加到 messages 末尾**，而不是 concat 进
 * systemMessage。
 *
 * ⚠️ 不要"为了 recency"把它改回 systemMessage —— 这正是本函数存在的原因：
 * wrapModelCall 在**每次模型调用前**都会执行，而画布状态在一轮内随每个 add_node / connect_nodes
 * 变化。拼进 system prompt 会让每次调用的前缀都不同；system prompt 排在 messages 之前，前缀一变，
 * 整段对话历史的 prompt cache 就全部失效。实测（会话 cms39bt5t，Gemini 3.5 Flash Lite）一轮 15 次
 * 调用命中率 0%，343K 输入 token 全额计费 —— 连同一轮内部都命不中。
 *
 * 追加到末尾是 append-only：第 N 次调用的前缀 = 第 N-1 次的全部内容 + 新增部分，每次都能命中
 * 此前的完整前缀。代价是上下文里留有历史状态快照，但它们按缓存价计费；CANVAS_SYSTEM_PROMPT 已
 * 声明「以最后出现的那一份为准」，避免模型读到过期快照。
 *
 * recency 也不吃亏：messages 末尾比 system prompt 末尾更靠近生成位置。
 */
export async function injectLiveCanvasState(
  request: {
    messages: BaseMessage[];
    runtime?: { context?: { sessionId?: string } };
  },
  handler: (req: unknown) => unknown,
  getCanvasContext?: (sessionId: string) => Promise<string>,
): Promise<unknown> {
  const sid = request.runtime?.context?.sessionId;
  if (!sid || !getCanvasContext) return handler(request);
  const text = await getCanvasContext(sid);
  if (!text) return handler(request);
  return handler({
    ...request,
    messages: [...request.messages, new HumanMessage(text)],
  });
}
