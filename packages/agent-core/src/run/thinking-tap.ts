import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { thinkingText } from '../agent/event-normalizer';
import type {
  ReasoningCollector,
  ReasoningPart,
} from '../agent/reasoning-parts';

/**
 * Gemini 思考的实时推流（可选，宿主挂到 `agent.stream` 的 callbacks 上）。
 *
 * Gemini 流式时思考是一段段到的（实测首段约 3.5s，正文要 7s+），但 langgraph 的 messages 流会把 chunk
 * 的 content 压成字符串、思考块丢了，updates 又要等这一步跑完才整段给。这里直接从模型吐出的每个 chunk
 * 里取思考片段推给前端。
 *
 * 必须与 consumeAgentStream 共用同一个 ReasoningCollector（经 ConsumeStreamOptions.reasoning 传入）：
 * 片段按消息 id 归集，之后 updates 里的整段会被认成同一块而丢弃，不会重复推、重复落库。
 * chunk 没有消息 id 就不实时推：换个 key 归集会和 updates 里按最终消息 id 取的整段对不上、落两份，
 * 这种情况交给 updates 整段给出。
 */
export function createThinkingTap(
  reasoning: ReasoningCollector,
  emit: (part: ReasoningPart) => void | Promise<void>,
): BaseCallbackHandler {
  return BaseCallbackHandler.fromMethods({
    handleLLMNewToken: async (_token, _idx, _runId, _parent, _tags, fields) => {
      const chunk = fields?.chunk;
      if (!chunk || !('message' in chunk) || !chunk.message.id) return;
      const text = thinkingText(chunk.message.content);
      if (!text) return;
      const part = reasoning.appendDelta(chunk.message.id, text);
      if (part) await emit(part);
    },
  });
}
