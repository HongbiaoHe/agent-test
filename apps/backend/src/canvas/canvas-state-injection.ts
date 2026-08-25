import { HumanMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * 画布 agent 的**上下文注入**（实时画布状态 + 当前任务计划）。纯逻辑，刻意不依赖 deepagents，
 * 便于在 jest 里单测；同 agent/plan-injection.ts。
 *
 * 走 **beforeModel** 而不是 wrapModelCall —— 这是保住 prompt cache 的关键，别改回去：
 *
 * wrapModelCall 拿到的 request 是**一次性**的。langchain 1.4.2 里每次模型调用的 request 都以
 * `messages: state.messages` 重新构造（AgentNode.js:328），而只有模型返回的 AIMessage 会经
 * `Command({update:{messages:[...]}})` 写回 state（AgentNode.js:101）。也就是说 wrapModelCall 里
 * 追加的消息**不进 state**，下次调用就消失了。于是前缀长这样：
 *
 *   调用 N  ：SYS + M(N) + [画布状态_N]
 *   调用 N+1：SYS + M(N) + ai + tool + [画布状态_N+1]
 *                    └── 公共前缀到此为止，画布状态_N 整段作废
 *
 * 注入的快照每次都"漂"在末尾，后面永远接不上东西 —— 每轮都要重付一次全量画布状态。实测 48 节点
 * 的会话每份快照 ≈3.6K token，一个 15 次调用的 run 白付 ≈54K，占该 run 全部输入的近 20%。
 *
 * beforeModel 的返回值是 state 更新（middleware.d.ts:181，返回 undefined 则透传），消息会经 reducer
 * 落进 state 与 checkpointer，于是前缀真正 append-only：调用 N+1 的前缀 = 调用 N 的全部内容 + 新增。
 *
 * 另外**画布没变就不注入**（比对上一份快照）：不注入的那次调用前缀与上次完全一致 = 纯命中。
 * 代价是上下文里留有历史快照，但它们按缓存价计费；CANVAS_SYSTEM_PROMPT 已声明「以最后出现的
 * 那一份为准」，避免模型读到过期快照。
 */

/** 注入消息的识别标记：作为正文首行，回读时据此找出上一份同类注入。 */
export const CANVAS_STATE_MARKER = '## 当前画布实时状态';
export const CANVAS_PLAN_MARKER = '## 当前任务计划';

/**
 * 算出本次模型调用前要追加的画布状态消息。
 * 返回 undefined = 不更新 state（无 sessionId / 取不到文本 / 画布与上一份快照一致）。
 */
export async function buildCanvasStateUpdate(
  state: { messages: BaseMessage[] },
  sessionId: string | undefined,
  getCanvasContext?: (sessionId: string) => Promise<string>,
): Promise<{ messages: BaseMessage[] } | undefined> {
  if (!sessionId || !getCanvasContext) return undefined;
  const text = await getCanvasContext(sessionId);
  if (!text) return undefined;
  if (lastMarked(state.messages, CANVAS_STATE_MARKER) === text)
    return undefined;
  return { messages: [new HumanMessage(text)] };
}

/**
 * 算出本次模型调用前要追加的「当前任务计划」消息。
 *
 * 同样刻意**不**走 systemMessage.concat（主 agent 的 plan-injection.injectActivePlan 是那么做的）：
 * system prompt 排在全部 messages 之前，计划一变，整段对话历史的 prompt cache 立刻全废。实测跨 run
 * 首次调用只能命中到 activePlan 之前那一小段（9252 input / 4025 cacheRead），历史全额重付。
 *
 * activePlan 由 worker 每次 run 开始时从 DB 算出、经 context 传入，run 内是常量 —— 因此只有跨 run
 * 计划真的推进了才会追加新的一份，前缀保持 append-only。
 *
 * recency 不吃亏：messages 末尾比 system prompt 末尾更靠近生成位置；且本中间件排在画布状态之前，
 * 画布状态仍是离模型最近的那一条。
 */
export function buildPlanUpdate(
  state: { messages: BaseMessage[] },
  activePlan: string | undefined,
): { messages: BaseMessage[] } | undefined {
  if (!activePlan) return undefined;
  if (lastMarked(state.messages, CANVAS_PLAN_MARKER) === activePlan) {
    return undefined;
  }
  return { messages: [new HumanMessage(activePlan)] };
}

/** 倒序找最后一条以 marker 开头的消息正文；没有则 null。 */
function lastMarked(messages: BaseMessage[], marker: string): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i].text;
    if (text.startsWith(marker)) return text;
  }
  return null;
}
