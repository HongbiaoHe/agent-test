import type { RawEvent } from '@agent-test/agent-core/agent/event-normalizer';
import { ReasoningCollector } from '@agent-test/agent-core/agent/reasoning-parts';
import {
  consumeAgentStream,
  type TurnSink,
} from '@agent-test/agent-core/run/consume-stream';
import { roleOf } from '@agent-test/agent-core/run/history';
import { createThinkingTap } from '@agent-test/agent-core/run/thinking-tap';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type MessageContent,
} from '@langchain/core/messages';
import type { Job } from 'bullmq';
import { AbortRegistry } from '../../agent/abort-registry';
import { StreamService } from '../../events/stream.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DesignAssetsService } from '../design-assets.service';
import { DesignDecomposeService } from '../design-decompose.service';
import { DesignGenerationService } from '../design-generation.service';
import { DesignService } from '../design.service';
import { DesignRenderService } from '../render/design-render.service';
import { buildDesignAgent } from './design.agent.factory';
import { designEvent } from './design-events';
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
      // 思考归集器与实时回调共用（见 agent-core run/thinking-tap）：Gemini 思考边生成边推，
      // updates 里的整段认成同一块不再重复。重放的历史只有正文、不带思考块，不需要 priorIds。
      const reasoning = new ReasoningCollector();
      const thinkingTap = createThinkingTap(reasoning, (part) =>
        publish({ type: 'reasoning', payload: part }),
      );
      const stream = await agent.stream(
        { messages },
        {
          signal,
          streamMode: ['updates', 'messages'],
          recursionLimit: 400,
          callbacks: [thinkingTap],
          // buildAgent 的 context schema 要求 userId
          context: { userId: doc.userId },
        },
      );

      // 文本段收口、回显去重、思考落库、停止时收口残余文本都在 core 的 consumeAgentStream；
      // 这里只给落点与设计专属的事件改写。设计会话不记 token 明细（sink 不实现 recordUsage）。
      const sink: TurnSink = {
        emit: publish,
        // 计划只推流不落库（设计面板不从历史重建计划）
        persist: (evt) =>
          evt.type === 'plan_update'
            ? undefined
            : persist(roleOf(evt.type), evt),
      };
      await consumeAgentStream(stream, sink, {
        reasoning,
        signal,
        mapEvent: designEvent,
      });
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

/** 事件载荷都是 JSON 可表示的普通对象；往返一次即得 Prisma 认的 InputJsonValue。 */
function toJsonValue(value: unknown) {
  return JSON.parse(
    JSON.stringify(value ?? null),
  ) as import('@prisma/client').Prisma.InputJsonValue;
}
