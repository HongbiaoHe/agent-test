import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { RawEvent } from '../agent/event-normalizer';
import {
  ReasoningCollector,
  type ReasoningPart,
} from '../agent/reasoning-parts';
import { consumeAgentStream } from './consume-stream';
import { createThinkingTap } from './thinking-tap';

/** 模拟模型吐出一个流式 chunk（Gemini includeThoughts：思考在 content 的 thinking 块里） */
function chunkOf(content: AIMessageChunk['content'], id?: string) {
  return new ChatGenerationChunk({
    text: '',
    message: new AIMessageChunk({ id, content }),
  });
}

async function feed(
  tap: ReturnType<typeof createThinkingTap>,
  chunk: ChatGenerationChunk,
) {
  await tap.handleLLMNewToken?.(
    '',
    { prompt: 0, completion: 0 },
    'run-1',
    undefined,
    undefined,
    {
      chunk,
    },
  );
}

describe('createThinkingTap', () => {
  it('思考片段逐段推出（按消息 id 归集）；正文 chunk 不推', async () => {
    const reasoning = new ReasoningCollector();
    const pushed: ReasoningPart[] = [];
    const tap = createThinkingTap(reasoning, (p) => {
      pushed.push(p);
    });
    await feed(tap, chunkOf([{ type: 'thinking', thinking: '先看' }], 'm1'));
    await feed(tap, chunkOf([{ type: 'thinking', thinking: '版面' }], 'm1'));
    await feed(tap, chunkOf('正文'));
    expect(pushed).toEqual([
      { sourceId: 'm1', text: '先看' },
      { sourceId: 'm1', text: '版面' },
    ]);
  });

  it('chunk 没有消息 id 就不实时推（交给 updates 整段给出，免得两个 key 落两份）', async () => {
    const reasoning = new ReasoningCollector();
    const pushed: ReasoningPart[] = [];
    const tap = createThinkingTap(reasoning, (p) => {
      pushed.push(p);
    });
    await feed(tap, chunkOf([{ type: 'thinking', thinking: 'x' }]));
    expect(pushed).toEqual([]);
    expect(reasoning.drain()).toEqual([]);
  });

  it('与 consumeAgentStream 共用归集器：updates 里同一条消息的整段思考不再重复推、只落一行', async () => {
    const reasoning = new ReasoningCollector();
    const log: { op: string; event: RawEvent }[] = [];
    const sink = {
      emit: (event: RawEvent) => {
        log.push({ op: 'emit', event });
      },
      persist: (event: RawEvent) => {
        log.push({ op: 'persist', event });
      },
      recordUsage: () => null,
    };
    const tap = createThinkingTap(reasoning, (p) =>
      sink.emit({ type: 'reasoning', payload: p }),
    );
    await feed(
      tap,
      chunkOf([{ type: 'thinking', thinking: '先看版面' }], 'm1'),
    );

    async function* stream() {
      yield [
        'updates',
        {
          model_request: {
            messages: [
              new AIMessage({
                id: 'm1',
                content: [
                  { type: 'thinking', thinking: '先看版面' },
                  { type: 'text', text: '好了' },
                ],
              }),
            ],
          },
        },
      ];
    }
    await consumeAgentStream(stream(), sink, {
      seenUsageIds: new Set(),
      fallbackModel: 'gemini-x',
      reasoning,
    });
    const reasoningOps = log.filter((l) => l.event.type === 'reasoning');
    expect(reasoningOps.map((l) => l.op)).toEqual(['emit', 'persist']);
    expect(reasoningOps[1].event.payload).toEqual({
      sourceId: 'm1',
      text: '先看版面',
    });
  });
});
