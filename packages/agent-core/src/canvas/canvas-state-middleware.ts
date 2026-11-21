import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { CANVAS_STATE_MARKER } from '@agent-test/canvas-schema';
import { createMiddleware, type AgentMiddleware } from 'langchain';

/**
 * 画布状态注入（服务端画布 agent 与 desktop 本机 agent 共用）：每次调模型前取一份最新的画布文本
 * （@agent-test/canvas-schema 的 buildAgentCanvasContext），**和上一份不一样时**才作为一条 HumanMessage
 * 追加进 state。
 *
 * 走 beforeModel 而不是 wrapModelCall —— 这是保住 prompt cache 的关键：wrapModelCall 改的 request
 * 不写回 state，注入的快照下次调用就消失，前缀每轮都在末尾分叉、白付一份全量画布状态；beforeModel 的
 * 返回值经 reducer 落进 state，前缀 append-only。画布没变就不注入，那次调用前缀与上次完全一致。
 * 代价是上下文里留有历史快照：系统提示里要声明「以最后出现的那一份为准」。
 */

/**
 * 算出本次模型调用前要追加的画布状态消息。
 * 返回 undefined = 不更新 state（取不到文本 / 画布与上一份注入一致）。
 */
export async function buildCanvasStateUpdate(
  state: { messages: BaseMessage[] },
  getCanvasContext: () => Promise<string | null>,
): Promise<{ messages: BaseMessage[] } | undefined> {
  const text = await getCanvasContext();
  if (!text) return undefined;
  if (lastMarked(state.messages, CANVAS_STATE_MARKER) === text)
    return undefined;
  return { messages: [new HumanMessage(text)] };
}

/** 倒序找最后一条以 marker 开头的消息正文；没有则 null。 */
export function lastMarked(
  messages: BaseMessage[],
  marker: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i].text;
    if (text.startsWith(marker)) return text;
  }
  return null;
}

/**
 * 画布状态注入中间件。getCanvasContext 由宿主闭包提供：返回 null = 当前没有画布（不注入）。
 * 排在中间件链靠后的位置（离模型越近，读到的越新）。
 */
export function createCanvasStateMiddleware(
  getCanvasContext: () => Promise<string | null>,
): AgentMiddleware {
  return createMiddleware({
    name: 'canvasLiveStateMiddleware',
    beforeModel: (state: { messages: BaseMessage[] }) =>
      buildCanvasStateUpdate(state, getCanvasContext),
  });
}
