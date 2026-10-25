import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { mediaDataDir, readParams } from '../media/media.service';
import { isSettled, type AnalysisRow } from './attachment-analysis';
import { analyzeMediaWithGemini } from './gemini-media';
import {
  ANALYSIS_SCHEMAS,
  analysisPrompt,
  isAnalyzableType,
  type AnalyzableType,
} from './media-analysis.schema';

/** 做分析的模型：与 agent 选什么模型无关，固定用便宜的多模态 Flash（可用环境变量覆盖） */
export function analysisModel(): string {
  return process.env.MEDIA_ANALYSIS_MODEL || 'gemini-3.8-flash';
}

const FETCH_TIMEOUT_MS = 60_000;
const GEMINI_TIMEOUT_MS = 180_000;
const WAIT_POLL_MS = 500;
/** pending 超过这么久还没动静（job 丢了，如 Redis 重启）就重新投 */
const STALE_PENDING_MS = 5 * 60_000;

/** 文件扩展名 → MIME（上传版本带 contentType；aigc 产物没有，按 URL 后缀猜） */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};
const TYPE_DEFAULT_MIME: Record<AnalyzableType, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
};

/**
 * 附件理解：用户发出的图片 / 视频 / 音频交给视觉模型并发分析，结构化描述按 versionId 存进
 * MediaAnalysis。发送时投任务（enqueue），worker 开跑前等结果（waitFor），agent 按需取细节（get）。
 */
@Injectable()
export class MediaAnalysisService {
  private readonly logger = new Logger(MediaAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('media-analyze') private readonly queue: Queue,
  ) {}

  /**
   * 为这些版本投分析任务。已分析完（或正在分析）的直接复用，久无动静的重投——
   * 同一附件重复发送不会再分析一次。
   *
   * retryFailed：失败过的要不要重投。用户发送消息时重投（给一次重来的机会，比如环境修好了）；
   * agent 工具里不重投——否则 agent 每调一次工具就重新分析一遍，失败原因没变的话只是白等
   * （2026-10-25 实测：连不上 Gemini 时每次调用干等约 22 秒，agent 连调 5 轮）。
   */
  async enqueue(
    versionIds: readonly string[],
    { retryFailed = true }: { retryFailed?: boolean } = {},
  ): Promise<void> {
    for (const versionId of new Set(versionIds)) {
      const existing = await this.prisma.mediaAnalysis.findUnique({
        where: { versionId },
      });
      const stale =
        existing?.status === 'pending' &&
        Date.now() - existing.updatedAt.getTime() > STALE_PENDING_MS;
      const retry = existing?.status === 'failed' && retryFailed;
      if (existing && !retry && !stale) continue;
      await this.prisma.mediaAnalysis.upsert({
        where: { versionId },
        create: { versionId, status: 'pending' },
        update: { status: 'pending', error: null },
      });
      await this.queue.add(
        'analyze',
        { versionId },
        {
          // BullMQ 不许自定义 id 里带冒号（三段式的重复任务格式除外），用连字符
          jobId: `analyze-${versionId}`,
          // 结束即清：不清的话同 jobId 的重投会被 BullMQ 去重吞掉
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    }
  }

  /** 分析一个版本（media-analyze worker 调）。失败落 failed，不抛出。 */
  async analyze(versionId: string): Promise<void> {
    const v = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    const type = v?.generation.type ?? '';
    if (!v || !isAnalyzableType(type)) {
      await this.settle(versionId, { status: 'skipped' });
      return;
    }
    // 测试模式的占位素材不值得花钱看
    if (v.mock) {
      await this.settle(versionId, { status: 'skipped' });
      return;
    }
    if (v.status !== 'done' || (!v.url && !v.filePath)) {
      await this.settle(versionId, {
        status: 'failed',
        error: `素材不可用（status=${v.status}）`,
      });
      return;
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      await this.settle(versionId, {
        status: 'failed',
        error: '未配置 GOOGLE_API_KEY',
      });
      return;
    }

    const model = analysisModel();
    const schema = ANALYSIS_SCHEMAS[type];
    try {
      const bytes = v.filePath
        ? await readFile(join(mediaDataDir(), v.filePath))
        : await fetchBytes(v.url ?? '');
      const mimeType = mimeOf(type, readParams(v.params).contentType, v.url);
      const jsonSchema = withoutMeta(z.toJSONSchema(schema));
      // 模型偶发空回复 / 结构不合：重试一次。连不上（网络不通、代理没配）重试也没用，直接失败
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await analyzeMediaWithGemini({
            apiKey,
            model,
            bytes,
            mimeType,
            prompt: analysisPrompt(type),
            jsonSchema,
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          });
          const parsed = schema.parse(JSON.parse(res.text));
          await this.settle(versionId, {
            status: 'done',
            summary: parsed.summary,
            detail: parsed,
            model,
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
          });
          this.logger.log(
            `附件理解完成 versionId=${versionId} ${type} in=${res.inputTokens} out=${res.outputTokens}`,
          );
          return;
        } catch (e) {
          lastError = e;
          if (isNetworkError(e)) break;
        }
      }
      throw lastError;
    } catch (e) {
      const message = isNetworkError(e)
        ? `连不上分析服务（${errorCode(e) ?? '网络错误'}）`
        : e instanceof Error
          ? e.message
          : String(e);
      this.logger.warn(`附件理解失败 versionId=${versionId}: ${message}`);
      await this.settle(versionId, {
        status: 'failed',
        model,
        error: message.slice(0, 500),
      });
    }
  }

  /**
   * 等这些版本的分析到终态（或超时 / 中止），期间完成数变化就回调一次。
   * 返回此刻的分析行（可能有还没完成的）。
   */
  async waitFor(
    versionIds: readonly string[],
    timeoutMs: number,
    onProgress?: (done: number) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<AnalysisRow[]> {
    const deadline = Date.now() + timeoutMs;
    let lastDone = -1;
    while (true) {
      const rows = await this.rows(versionIds);
      const done = rows.filter((r) => isSettled(r.status)).length;
      if (done !== lastDone) {
        lastDone = done;
        await onProgress?.(done);
      }
      if (
        done >= versionIds.length ||
        Date.now() >= deadline ||
        signal?.aborted
      ) {
        return rows;
      }
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }

  /**
   * 取一个版本的分析（agent 工具用）：校验归属；从没分析过的现投，再等最多 timeoutMs。
   * 失败过的不重投——直接把失败结果交回去，免得 agent 每调一次就白等一轮。
   */
  async getForUser(
    versionId: string,
    userId: string,
    timeoutMs: number,
  ): Promise<
    | { error: string }
    | { versionId: string; type: string; row: AnalysisRow | null }
  > {
    const v = await this.prisma.mediaVersion.findUnique({
      where: { id: versionId },
      include: { generation: true },
    });
    if (!v || v.generation.userId !== userId) {
      return { error: '没有这个素材（versionId 不存在或不属于当前用户）' };
    }
    await this.enqueue([versionId], { retryFailed: false });
    const [row] = await this.waitFor([versionId], timeoutMs);
    return { versionId, type: v.generation.type, row: row ?? null };
  }

  private async rows(versionIds: readonly string[]): Promise<AnalysisRow[]> {
    return this.prisma.mediaAnalysis.findMany({
      where: { versionId: { in: [...versionIds] } },
      select: {
        versionId: true,
        status: true,
        summary: true,
        detail: true,
        error: true,
      },
    });
  }

  private async settle(
    versionId: string,
    data: {
      status: 'done' | 'failed' | 'skipped';
      summary?: string;
      detail?: object;
      model?: string;
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<void> {
    await this.prisma.mediaAnalysis.upsert({
      where: { versionId },
      create: { versionId, ...data },
      update: data,
    });
  }
}

/** 网络层错误（连接超时 / 被拒 / DNS / 断开）：重试也是同样的结果 */
const NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

/** 错误码：undici 的 fetch 把真正的原因挂在 cause 上（如 fetch failed ← UND_ERR_CONNECT_TIMEOUT） */
function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; depth++) {
    if (typeof cur !== 'object') break;
    if ('code' in cur && typeof cur.code === 'string') return cur.code;
    cur = 'cause' in cur ? cur.cause : null;
  }
  return null;
}

export function isNetworkError(e: unknown): boolean {
  const code = errorCode(e);
  if (code && NETWORK_CODES.has(code)) return true;
  return e instanceof Error && e.message === 'fetch failed';
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`下载素材失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function mimeOf(
  type: AnalyzableType,
  contentType: string | undefined,
  url: string | null,
): string {
  if (contentType) return contentType;
  const ext = url?.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? TYPE_DEFAULT_MIME[type];
}

/** z.toJSONSchema 带 $schema 元字段，Gemini 的 responseJsonSchema 不需要它 */
function withoutMeta(schema: object): object {
  return Object.fromEntries(
    Object.entries(schema).filter(([k]) => k !== '$schema'),
  );
}
