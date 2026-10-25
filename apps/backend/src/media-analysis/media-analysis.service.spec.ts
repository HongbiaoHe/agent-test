import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { analyzeMediaWithGemini } from './gemini-media';
import { MediaAnalysisService } from './media-analysis.service';

jest.mock('./gemini-media', () => ({ analyzeMediaWithGemini: jest.fn() }));

describe('MediaAnalysisService', () => {
  let service: MediaAnalysisService;
  const prisma = {
    mediaAnalysis: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    mediaVersion: { findUnique: jest.fn() },
  };
  const queue = { add: jest.fn() };
  const gemini = jest.mocked(analyzeMediaWithGemini);
  const prevKey = process.env.GOOGLE_API_KEY;

  beforeEach(async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const module = await Test.createTestingModule({
      providers: [
        MediaAnalysisService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('media-analyze'), useValue: queue },
      ],
    }).compile();
    service = module.get(MediaAnalysisService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_API_KEY = prevKey;
  });

  describe('enqueue', () => {
    it('没分析过：建 pending 行并投任务（结束即清，免得重投被去重吞掉）', async () => {
      prisma.mediaAnalysis.findUnique.mockResolvedValue(null);
      await service.enqueue(['v1', 'v1']);
      expect(prisma.mediaAnalysis.upsert).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'analyze',
        { versionId: 'v1' },
        expect.objectContaining({
          jobId: 'analyze-v1',
          removeOnComplete: true,
          removeOnFail: true,
        }),
      );
    });

    it('已分析完 / 正在分析：复用，不再投', async () => {
      prisma.mediaAnalysis.findUnique
        .mockResolvedValueOnce({ status: 'done', updatedAt: new Date() })
        .mockResolvedValueOnce({ status: 'pending', updatedAt: new Date() });
      await service.enqueue(['v1', 'v2']);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('失败过的、pending 久无动静的：重投', async () => {
      prisma.mediaAnalysis.findUnique
        .mockResolvedValueOnce({ status: 'failed', updatedAt: new Date() })
        .mockResolvedValueOnce({
          status: 'pending',
          updatedAt: new Date(Date.now() - 10 * 60_000),
        });
      await service.enqueue(['v1', 'v2']);
      expect(queue.add).toHaveBeenCalledTimes(2);
    });
  });

  describe('enqueue（工具路径）', () => {
    it('retryFailed=false：失败过的不重投（agent 重调工具不会重跑分析）', async () => {
      prisma.mediaAnalysis.findUnique.mockResolvedValue({
        status: 'failed',
        updatedAt: new Date(),
      });
      await service.enqueue(['v1'], { retryFailed: false });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('getForUser 走的就是不重投的路径：失败结果直接交回', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue({
        id: 'v1',
        generation: { userId: 'u1', type: 'image' },
      });
      prisma.mediaAnalysis.findUnique.mockResolvedValue({
        status: 'failed',
        updatedAt: new Date(),
      });
      prisma.mediaAnalysis.findMany.mockResolvedValue([
        { versionId: 'v1', status: 'failed', error: '连不上分析服务' },
      ]);

      const r = await service.getForUser('v1', 'u1', 60_000);

      expect(queue.add).not.toHaveBeenCalled();
      expect(r).toMatchObject({ row: { status: 'failed' } });
    });
  });

  describe('analyze', () => {
    const version = (extra: object = {}) => ({
      id: 'v1',
      status: 'done',
      mock: false,
      url: 'https://cdn/shoe.png',
      filePath: null,
      params: { contentType: 'image/png' },
      generation: { type: 'image' },
      ...extra,
    });
    const settled = () =>
      prisma.mediaAnalysis.upsert.mock.calls.at(-1)?.[0] as {
        update: Record<string, unknown>;
      };

    beforeEach(() => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(Buffer.from('PNG'), { status: 200 }));
    });
    afterEach(() => jest.restoreAllMocks());

    const imageJson = JSON.stringify({
      summary: '白色跑鞋棚拍产品图',
      subject: '白色网面跑鞋',
      scene: '纯灰背景',
      composition: '3/4 侧视居中',
      lighting_color: '冷白顶光',
      style: '棚拍',
      orientation: '横版',
      text_in_image: '无',
      usable_as: ['产品参考图'],
    });

    it('成功：按类型的 schema 解析，摘要 / 细节 / token 落库', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(version());
      gemini.mockResolvedValue({
        text: imageJson,
        inputTokens: 300,
        outputTokens: 120,
      });

      await service.analyze('v1');

      expect(gemini).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'image/png', apiKey: 'test-key' }),
      );
      expect(settled().update).toMatchObject({
        status: 'done',
        summary: '白色跑鞋棚拍产品图',
        inputTokens: 300,
        outputTokens: 120,
      });
    });

    it('第一次失败：重试一次后成功', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(version());
      gemini
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          text: imageJson,
          inputTokens: 1,
          outputTokens: 1,
        });

      await service.analyze('v1');

      expect(gemini).toHaveBeenCalledTimes(2);
      expect(settled().update).toMatchObject({ status: 'done' });
    });

    it('两次都失败 / 返回不合 schema：落 failed 带原因，不抛出', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(version());
      gemini.mockResolvedValue({
        text: '{"summary": 1}',
        inputTokens: 1,
        outputTokens: 1,
      });

      await expect(service.analyze('v1')).resolves.toBeUndefined();
      expect(gemini).toHaveBeenCalledTimes(2);
      expect(settled().update).toMatchObject({ status: 'failed' });
    });

    it('连不上（网络错误）：不重试，原因写成人话', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(version());
      // undici 的 fetch 把真正原因挂在 cause 上
      gemini.mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
        }),
      );

      await service.analyze('v1');

      expect(gemini).toHaveBeenCalledTimes(1);
      expect(settled().update).toMatchObject({
        status: 'failed',
        error: '连不上分析服务（UND_ERR_CONNECT_TIMEOUT）',
      });
    });

    it('测试模式的占位素材：跳过，不调模型', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(version({ mock: true }));
      await service.analyze('v1');
      expect(gemini).not.toHaveBeenCalled();
      expect(settled().update).toMatchObject({ status: 'skipped' });
    });

    it('素材不可用：落 failed', async () => {
      prisma.mediaVersion.findUnique.mockResolvedValue(
        version({ status: 'staged' }),
      );
      await service.analyze('v1');
      expect(gemini).not.toHaveBeenCalled();
      expect(settled().update).toMatchObject({ status: 'failed' });
    });
  });

  describe('waitFor', () => {
    it('完成数变化就回调，全部到终态即返回', async () => {
      prisma.mediaAnalysis.findMany
        .mockResolvedValueOnce([
          { versionId: 'v1', status: 'pending' },
          { versionId: 'v2', status: 'pending' },
        ])
        .mockResolvedValueOnce([
          { versionId: 'v1', status: 'done' },
          { versionId: 'v2', status: 'pending' },
        ])
        .mockResolvedValue([
          { versionId: 'v1', status: 'done' },
          { versionId: 'v2', status: 'failed' },
        ]);
      const progress: number[] = [];

      const rows = await service.waitFor(['v1', 'v2'], 10_000, (d) => {
        progress.push(d);
      });

      expect(progress).toEqual([0, 1, 2]);
      expect(rows.map((r) => r.status)).toEqual(['done', 'failed']);
    });

    it('到点还没完成：返回此刻的结果', async () => {
      prisma.mediaAnalysis.findMany.mockResolvedValue([
        { versionId: 'v1', status: 'pending' },
      ]);
      const rows = await service.waitFor(['v1'], 0);
      expect(rows).toEqual([{ versionId: 'v1', status: 'pending' }]);
    });
  });

  it('getForUser：不属于当前用户的素材拒绝', async () => {
    prisma.mediaVersion.findUnique.mockResolvedValue({
      id: 'v1',
      generation: { userId: 'someone-else', type: 'image' },
    });
    expect(await service.getForUser('v1', 'u1', 0)).toEqual({
      error: expect.stringContaining('不属于当前用户'),
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
