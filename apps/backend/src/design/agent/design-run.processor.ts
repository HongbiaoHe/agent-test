import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Job } from 'bullmq';
import { AbortRegistry } from '../../agent/abort-registry';
import {
  extractThinkingBlocks,
  normalize,
  type RawEvent,
} from '../../agent/event-normalizer';
import {
  type ReasoningPart,
  ReasoningCollector,
} from '../../agent/reasoning-parts';
import { StreamService } from '../../events/stream.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DesignAssetsService } from '../design-assets.service';
import { DesignDecomposeService } from '../design-decompose.service';
import { DesignGenerationService } from '../design-generation.service';
import { DesignService } from '../design.service';
import { DesignRenderService } from '../render/design-render.service';
import { buildDesignAgent } from './design.agent.factory';
import { createDesignTools, summarizeDocument } from './design.tools';
import {
  DESIGN_ABORTS,
  DESIGN_RUN_QUEUE,
  type DesignRunJob,
} from './design-agent.service';
import {
  type DesignUserMessage,
  designUserMessageSchema,
} from './design-message';

/** 重放给模型的历史条数上限（只重放用户与助手的正文，工具细节不重放）。 */
const HISTORY_LIMIT = 30;

@Processor(DESIGN_RUN_QUEUE, { concurrency: 4, lockDuration: 600_000 })
export class DesignRunProcessor extends WorkerHost {
  private readonly logger = new Logger(DesignRunProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: StreamService,
    private readonly design: DesignService,
    private readonly generation: DesignGenerationService,
    private readonly render: DesignRenderService,
    private readonly assets: DesignAssetsService,
    private readonly decompose: DesignDecomposeService,
    @Inject(DESIGN_ABORTS) private readonly aborts: AbortRegistry,
  ) {
    super();
  }

  async process(job: Job<DesignRunJob>): Promise<void> {
    const { docId } = job.data;
    const { signal, dispose } = this.aborts.register(docId);
    const runId = job.id ?? `${docId}-${Date.now()}`;
    let seq = await this.prisma.designMessage.count({ where: { docId } });
    const persist = async (role: string, evt: RawEvent) => {
      await this.prisma.designMessage.create({
        data: {
          docId,
          runId,
          role,
          type: evt.type,
          content: toJsonValue(evt.payload),
          seq: seq++,
        },
      });
    };
    const publish = (evt: RawEvent) => this.stream.publish(docId, evt);
    try {
      const doc = await this.prisma.designDoc.findUniqueOrThrow({
        where: { id: docId },
      });
      if (doc.status !== 'running') return; // 排队期间被停止
      const messages = await this.loadHistory(docId);
      const tools = createDesignTools({
        docId,
        design: this.design,
        generation: this.generation,
        render: this.render,
        assets: this.assets,
        decompose: this.decompose,
        seedream: this.decompose.enabled(),
        publish,
        generations: { count: 0 },
      });
      const agent = await buildDesignAgent({
        model: doc.model,
        tools,
        seedream: this.decompose.enabled(),
      });
      // 思考按源消息归集（同 canvas.processor）：推流时给增量 / 整块，收口时每段落一行，
      // 历史里也能看到完整思考。重放的历史消息只有正文、不带思考块，不需要 priorIds。
      const reasoning = new ReasoningCollector();
      const pushReasoning = async (part: ReasoningPart | null) => {
        if (part) await publish({ type: 'reasoning', payload: part });
      };
      /**
       * 思考实时推流：Gemini 流式时思考是一段段到的（实测首段约 3.5s，正文要 7s+），但 langgraph 的
       * messages 流会把 chunk 的 content 压成字符串、思考块丢了，updates 又要等这一步跑完才整段给。
       * 所以挂一个回调，直接从模型吐出的每个 chunk 里取思考片段推给前端；按消息 id 归集，
       * 之后 updates 里的整段会被 ReasoningCollector 认成同一块而丢弃，不会重复。
       */
      const thinkingTap = BaseCallbackHandler.fromMethods({
        handleLLMNewToken: async (
          _token,
          _idx,
          runId,
          _parent,
          _tags,
          fields,
        ) => {
          const chunk = fields?.chunk;
          if (!chunk || !('message' in chunk)) return;
          const text = thinkingText(chunk.message.content);
          if (!text) return;
          await pushReasoning(
            reasoning.appendDelta(chunk.message.id ?? `run-${runId}`, text),
          );
        },
      });
      const stream = await agent.stream(
        { messages },
        {
          signal,
          streamMode: ['updates', 'messages'],
          recursionLimit: 400,
          callbacks: [thinkingTap],
        },
      );

      let buf = '';
      let lastFlushed = '';
      const seenToolCalls = new Set<string>();
      /** 思考之后的第一个其它事件 / 本轮结束：把这段思考收口落库（seq 排在它后面的事件之前） */
      const flushReasoning = async () => {
        for (const part of reasoning.drain()) {
          await persist('assistant', { type: 'reasoning', payload: part });
        }
      };
      const flush = async (override?: string) => {
        const text = override ?? buf;
        buf = '';
        if (!text || text === lastFlushed) return;
        lastFlushed = text;
        const evt: RawEvent = {
          type: 'message',
          payload: { role: 'assistant', text },
        };
        await publish(evt);
        await persist('assistant', evt);
      };

      for await (const chunk of stream) {
        const [mode, data] = chunk as [string, unknown];
        // Gemini 的思考正文只在 updates 里（messages 流会把思考块压掉），整段一次给出
        if (mode === 'updates') {
          for (const part of extractThinkingBlocks(data)) {
            await pushReasoning(reasoning.takeBlock(part.id, part.text));
          }
        }
        const raw = normalize([], mode, data);
        if (!raw) continue;
        if (raw.type === 'reasoning') {
          const p = readReasoning(raw.payload);
          await pushReasoning(reasoning.appendDelta(p.sourceId, p.text));
          continue;
        }
        await flushReasoning();
        if (raw.type === 'token') {
          buf += readText(raw.payload);
          await publish(raw);
          continue;
        }
        if (raw.type === 'message') {
          await flush(buf || readText(raw.payload));
          continue;
        }
        if (raw.type === 'tool_start') {
          // updates 流会把同一条带 tool_calls 的 AIMessage 跨节点回显多次：按调用 id 去重
          const calls = toolCalls(raw.payload).filter(
            (c) => !seenToolCalls.has(c.id),
          );
          if (calls.length === 0) continue;
          calls.forEach((c) => seenToolCalls.add(c.id));
          await flush();
          lastFlushed = '';
          const evt: RawEvent = {
            type: 'tool_start',
            payload: { tool_calls: calls },
          };
          await publish(evt);
          await persist('assistant', evt);
          continue;
        }
        if (raw.type === 'tool_end') {
          // render_preview 的结果里有整张 base64 图：推流与落库前换成占位，只给模型看
          const evt: RawEvent = {
            type: 'tool_end',
            payload: stripImages(raw.payload),
          };
          await publish(evt);
          await persist('tool', evt);
          continue;
        }
        if (raw.type === 'plan_update') await publish(raw);
      }
      await flushReasoning();
      await flush();
      await this.finish(docId, 'done', persist);
    } catch (e) {
      if (signal.aborted) {
        await this.finish(docId, 'stopped', persist);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`design agent 失败 doc=${docId}：${message}`);
      const evt: RawEvent = { type: 'error', payload: { message } };
      await publish(evt);
      await persist('assistant', evt);
      await this.design.setStatus(docId, 'failed');
    } finally {
      dispose();
    }
  }

  private async finish(
    docId: string,
    status: 'done' | 'stopped',
    persist: (role: string, evt: RawEvent) => Promise<void>,
  ) {
    const evt: RawEvent = { type: 'result', payload: { status } };
    await this.stream.publish(docId, evt);
    await persist('assistant', evt);
    await this.design.setStatus(docId, status);
  }

  /**
   * 历史重放：用户与助手的正文。只有**最后一条**用户消息带上附件图片本体与当前文档清单——
   * 旧附件以 URL 文字出现（模型仍能把它们当 referenceUrls 用），省 token。
   */
  private async loadHistory(docId: string): Promise<BaseMessage[]> {
    const rows = await this.prisma.designMessage.findMany({
      where: { docId, type: 'message' },
      orderBy: { seq: 'desc' },
      take: HISTORY_LIMIT,
    });
    rows.reverse();
    const lastUser = rows.findLastIndex((r) => r.role === 'user');
    const out: BaseMessage[] = [];
    for (const [i, row] of rows.entries()) {
      if (row.role === 'assistant') {
        const text = readText(row.content);
        if (text) out.push(new AIMessage(text));
        continue;
      }
      const parsed = designUserMessageSchema.safeParse(row.content);
      if (!parsed.success) continue;
      out.push(
        new HumanMessage({
          content:
            i === lastUser
              ? await this.latestUserContent(docId, parsed.data)
              : userText(parsed.data),
        }),
      );
    }
    return out;
  }

  private async latestUserContent(
    docId: string,
    msg: DesignUserMessage,
  ): Promise<MessageContent> {
    const { document } = await this.design.document(docId);
    const blocks: Exclude<MessageContent, string> = [];
    for (const [i, a] of msg.attachments.entries()) {
      try {
        const img = await this.assets.toModelImage(a.url);
        blocks.push({
          type: 'text',
          text: `附件${i + 1}（${a.filename}，${a.width}×${a.height}，url=${a.url}）：`,
        });
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        });
      } catch (e) {
        blocks.push({
          type: 'text',
          text: `附件${i + 1} 读取失败：${String(e)}（url=${a.url}）`,
        });
      }
    }
    const split = msg.splitLayerId
      ? document.layers.find((l) => l.id === msg.splitLayerId)
      : undefined;
    if (split?.type === 'image' && split.src) {
      const img = await this.assets.toModelImage(split.src);
      blocks.push({
        type: 'text',
        text: `要拆分的图层 ${split.id}（x=${Math.round(split.x)} y=${Math.round(split.y)} w=${Math.round(split.width)} h=${Math.round(split.height)}，url=${split.src}）：`,
      });
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      });
    }
    const selection = msg.selection.length
      ? `\n\n## 用户选中\n${msg.selection.join('、')}`
      : '';
    const splitNote = msg.splitLayerId
      ? `\n\n（这是一条「拆分图层」请求：按工作流 B 把图层 ${msg.splitLayerId} 拆成可编辑的子图层。）`
      : '';
    blocks.unshift({
      type: 'text',
      text: `${msg.text || '（无文字，见附件）'}${splitNote}`,
    });
    blocks.push({
      type: 'text',
      text: `${selection}\n\n## 当前文档\n${summarizeDocument(document)}`,
    });
    return blocks;
  }
}

function userText(msg: DesignUserMessage): string {
  const atts = msg.attachments.map(
    (a, i) => `附件${i + 1}：${a.filename} url=${a.url}`,
  );
  return [msg.text, ...atts].filter(Boolean).join('\n');
}

function readText(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'text' in payload) {
    return typeof payload.text === 'string' ? payload.text : '';
  }
  return '';
}

/** chunk 里的思考片段：content 数组中 `{ type: 'thinking', thinking }` 块（Gemini includeThoughts） */
function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const blocks: unknown[] = content;
  let out = '';
  for (const block of blocks) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'thinking' &&
      'thinking' in block &&
      typeof block.thinking === 'string'
    ) {
      out += block.thinking;
    }
  }
  return out;
}

/** normalize 给的思考增量：{ text, sourceId } */
function readReasoning(payload: unknown): ReasoningPart {
  const sourceId =
    payload &&
    typeof payload === 'object' &&
    'sourceId' in payload &&
    typeof payload.sourceId === 'string'
      ? payload.sourceId
      : '';
  return { sourceId, text: readText(payload) };
}

function toolCalls(
  payload: unknown,
): { id: string; name: string; args: unknown }[] {
  if (!payload || typeof payload !== 'object' || !('tool_calls' in payload))
    return [];
  const calls = payload.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((c: unknown) =>
    c && typeof c === 'object' && 'name' in c && typeof c.name === 'string'
      ? [
          {
            id: 'id' in c && typeof c.id === 'string' ? c.id : c.name,
            name: c.name,
            args: 'args' in c ? c.args : {},
          },
        ]
      : [],
  );
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

/** 事件载荷都是 JSON 可表示的普通对象；往返一次即得 Prisma 认的 InputJsonValue。 */
function toJsonValue(value: unknown) {
  return JSON.parse(
    JSON.stringify(value ?? null),
  ) as import('@prisma/client').Prisma.InputJsonValue;
}
