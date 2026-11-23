import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type VideoReview, VideoReviewSchema } from '@agent-test/video-schema';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { mediaDataDir } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import { analyzeMediaWithGemini } from './gemini-media';
import {
  analysisModel,
  fetchBytes,
  isNetworkError,
  withoutMeta,
} from './media-analysis.service';

const GEMINI_TIMEOUT_MS = 180_000;

export function reviewPrompt(brief: string, outline: string): string {
  return [
    '你是资深的短视频 / 广告剪辑总监。下面是一条剪好的成片（低清预览，已烧录字幕、已混音），请审看后给出可执行的修改意见。',
    '',
    '## 这条片子的意图（brief）',
    brief.trim() || '（未提供）',
    '',
    '## 时间线（镜头 / 配音 / 字幕在成片里的起止时间，供你对照定位）',
    outline.trim() || '（未提供）',
    '',
    '## 必查清单',
    '1. 镜头衔接与节奏：有没有跳切生硬、某个镜头拖沓或太碎',
    '2. 字幕：是否清晰可读、有没有挡住人脸 / 产品等主体',
    '3. 主体与产品：该出现的主体 / 产品是否持续在画面里，前后是否一致',
    '4. 音画同步：口型、动作与声音是否对得上',
    '5. 配音与字幕：配音念的内容与字幕是否一致',
    '6. 开头 3 秒：能不能抓住注意力',
    '7. 对照 brief：要讲的卖点 / 信息有没有拍到、讲清楚',
    '',
    '## 输出要求',
    '- 只报真实看到 / 听到的问题，每条给出成片时间区间（秒）、严重程度、分类和具体改法；没问题的项不要硬凑。',
    '- severity：high = 不改不能交付；medium = 明显影响观感；low = 锦上添花。',
    '- 有 high 或 medium 的问题时 verdict = needs_work，否则 pass。',
    '- 全部用简体中文。',
  ].join('\n');
}

/**
 * 剪辑工程整片审片（desktop 的 review_video_project 工具调用）：desktop 先把低清预览经 /media-api/uploads
 * 传上来拿到 versionId，再调这里。用便宜的多模态 Flash（与附件理解同一个模型）按审片清单 + brief 看片，
 * 返回结构化意见（VideoReviewSchema，与 desktop 共用 @agent-test/video-schema）。
 *
 * 不扣积分；用量记在这个预览版本的 MediaAnalysis 行上（model / inputTokens / outputTokens，detail.kind =
 * 'video_review'），以后要不要收费按这些数据定。
 */
@Injectable()
export class VideoReviewService {
  private readonly logger = new Logger(VideoReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  async review(input: {
    userId: string;
    versionId: string;
    brief: string;
    outline: string;
  }): Promise<VideoReview> {
    const v = await this.prisma.mediaVersion.findUnique({
      where: { id: input.versionId },
      include: { generation: true },
    });
    if (!v || v.generation.userId !== input.userId) {
      throw new BusinessException(ErrorCodes.MEDIA_REF_INVALID);
    }
    if (v.status !== 'done' || (!v.url && !v.filePath)) {
      throw new BusinessException(ErrorCodes.MEDIA_ASSET_NOT_READY);
    }
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      this.logger.warn('审片失败：未配置 GOOGLE_API_KEY');
      throw new BusinessException(
        ErrorCodes.MEDIA_REVIEW_FAILED,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const model = analysisModel();
    try {
      const bytes = v.filePath
        ? await readFile(join(mediaDataDir(), v.filePath))
        : await fetchBytes(v.url ?? '');
      const jsonSchema = withoutMeta(z.toJSONSchema(VideoReviewSchema));
      // 模型偶发空回复 / 结构不合：重试一次。连不上重试也没用，直接失败
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await analyzeMediaWithGemini({
            apiKey,
            model,
            bytes,
            mimeType: 'video/mp4',
            prompt: reviewPrompt(input.brief, input.outline),
            jsonSchema,
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          });
          const review = VideoReviewSchema.parse(JSON.parse(res.text));
          const usage = {
            status: 'done',
            summary: review.summary,
            detail: { kind: 'video_review', brief: input.brief, ...review },
            model,
            error: null,
            inputTokens: res.inputTokens,
            outputTokens: res.outputTokens,
          };
          await this.prisma.mediaAnalysis.upsert({
            where: { versionId: v.id },
            create: { versionId: v.id, ...usage },
            update: usage,
          });
          this.logger.log(
            `审片完成 user=${input.userId} versionId=${v.id} issues=${review.issues.length} in=${res.inputTokens} out=${res.outputTokens}`,
          );
          return review;
        } catch (e) {
          lastError = e;
          if (isNetworkError(e)) break;
        }
      }
      throw lastError;
    } catch (e) {
      this.logger.warn(
        `审片失败 versionId=${v.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new BusinessException(
        ErrorCodes.MEDIA_REVIEW_FAILED,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
