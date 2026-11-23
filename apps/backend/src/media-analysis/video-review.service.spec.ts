import { Test } from '@nestjs/testing';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { analyzeMediaWithGemini } from './gemini-media';
import { reviewPrompt, VideoReviewService } from './video-review.service';

jest.mock('./gemini-media', () => ({ analyzeMediaWithGemini: jest.fn() }));

const REVIEW = {
  summary: '节奏顺，开头偏平',
  verdict: 'needs_work',
  strengths: ['产品特写清楚'],
  issues: [
    {
      start: 0,
      end: 3,
      severity: 'medium',
      category: 'hook',
      problem: '开头 3 秒是空镜',
      suggestion: '把产品特写提到开头',
    },
  ],
};

describe('VideoReviewService', () => {
  let service: VideoReviewService;
  const prisma = {
    mediaAnalysis: { upsert: jest.fn() },
    mediaVersion: { findUnique: jest.fn() },
  };
  const gemini = jest.mocked(analyzeMediaWithGemini);
  const prevKey = process.env.GOOGLE_API_KEY;
  const version = {
    id: 'ver1',
    status: 'done',
    url: 'https://cdn.example.com/preview.mp4',
    filePath: null,
    generation: { userId: 'u1' },
  };
  const input = {
    userId: 'u1',
    versionId: 'ver1',
    brief: '15 秒耳机广告',
    outline: '- v1 视频 0.00s–3.00s',
  };

  beforeEach(async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const module = await Test.createTestingModule({
      providers: [
        VideoReviewService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(VideoReviewService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    process.env.GOOGLE_API_KEY = prevKey;
  });

  it('按清单 + brief + 时间线审片，返回结构化意见，用量记在预览版本的分析行上', async () => {
    prisma.mediaVersion.findUnique.mockResolvedValue(version);
    gemini.mockResolvedValue({
      text: JSON.stringify(REVIEW),
      inputTokens: 1200,
      outputTokens: 300,
    });

    await expect(service.review(input)).resolves.toEqual(REVIEW);

    const call = gemini.mock.calls[0][0];
    expect(call.mimeType).toBe('video/mp4');
    expect(call.prompt).toContain('15 秒耳机广告');
    expect(call.prompt).toContain('- v1 视频 0.00s–3.00s');
    expect(call.prompt).toContain('开头 3 秒');
    expect(prisma.mediaAnalysis.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId: 'ver1' },
        create: expect.objectContaining({
          status: 'done',
          inputTokens: 1200,
          outputTokens: 300,
          detail: expect.objectContaining({
            kind: 'video_review',
            brief: '15 秒耳机广告',
          }),
        }),
      }),
    );
  });

  it('模型回了不合格式的内容：重试一次', async () => {
    prisma.mediaVersion.findUnique.mockResolvedValue(version);
    gemini
      .mockResolvedValueOnce({
        text: '{"summary":1}',
        inputTokens: 1,
        outputTokens: 1,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(REVIEW),
        inputTokens: 1,
        outputTokens: 1,
      });
    await expect(service.review(input)).resolves.toEqual(REVIEW);
    expect(gemini).toHaveBeenCalledTimes(2);
  });

  it('不是自己的版本：拒绝，不调模型', async () => {
    prisma.mediaVersion.findUnique.mockResolvedValue({
      ...version,
      generation: { userId: 'other' },
    });
    await expect(service.review(input)).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_REF_INVALID.code,
    });
    expect(gemini).not.toHaveBeenCalled();
  });

  it('两次都失败：报审片失败（业务错误，不泄露模型细节）', async () => {
    prisma.mediaVersion.findUnique.mockResolvedValue(version);
    gemini.mockRejectedValue(new Error('模型没有返回内容'));
    const err = await service.review(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect(err).toMatchObject({ errCode: ErrorCodes.MEDIA_REVIEW_FAILED.code });
    expect(prisma.mediaAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('提示词：没给 brief 时写明未提供', () => {
    expect(reviewPrompt('', '')).toContain('（未提供）');
  });
});
