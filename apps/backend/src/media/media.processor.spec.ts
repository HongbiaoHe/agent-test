/**
 * media.processor 单元测试：
 * - decideExt 纯函数（落盘后缀决策）
 * - waitForRef 等待逻辑（参考图就绪性轮询）
 */
import { Test } from '@nestjs/testing';
import { decideExt, MediaProcessor } from './media.processor';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { GoogleMediaClient } from './google-media.client';

describe('decideExt', () => {
  it('image/jpeg → jpg', () => expect(decideExt('image/jpeg')).toBe('jpg'));
  it('image/png → png', () => expect(decideExt('image/png')).toBe('png'));
  it('video/mp4 → mp4', () => expect(decideExt('video/mp4')).toBe('mp4'));
  it('未知图像类型兜底 png', () => expect(decideExt('image/webp')).toBe('png'));
});

describe('MediaProcessor.waitForRef', () => {
  const mockPrisma = { mediaVersion: { findUnique: jest.fn() } };
  const mockStream = { publish: jest.fn() };
  const mockClient = {};
  let processor: MediaProcessor;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: GoogleMediaClient, useValue: mockClient },
      ],
    }).compile();
    processor = module.get(MediaProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  it('ref 已 done → 立即返回版本', async () => {
    mockPrisma.mediaVersion.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'done',
      filePath: 'ref-1.png',
    });

    const v = await processor.waitForRef('ref-1', 10, 1_000);
    expect(v.id).toBe('ref-1');
    expect(mockPrisma.mediaVersion.findUnique).toHaveBeenCalledTimes(1);
  });

  it('ref generating→done 后继续执行', async () => {
    mockPrisma.mediaVersion.findUnique
      .mockResolvedValueOnce({ id: 'ref-1', status: 'generating', filePath: null })
      .mockResolvedValueOnce({ id: 'ref-1', status: 'done', filePath: 'ref-1.png' });

    const v = await processor.waitForRef('ref-1', 10, 5_000);
    expect(v.id).toBe('ref-1');
    expect(mockPrisma.mediaVersion.findUnique).toHaveBeenCalledTimes(2);
  });

  it('ref queued→done 后继续执行', async () => {
    mockPrisma.mediaVersion.findUnique
      .mockResolvedValueOnce({ id: 'ref-1', status: 'queued', filePath: null })
      .mockResolvedValueOnce({ id: 'ref-1', status: 'queued', filePath: null })
      .mockResolvedValueOnce({ id: 'ref-1', status: 'done', filePath: 'ref-1.png' });

    const v = await processor.waitForRef('ref-1', 10, 5_000);
    expect(v.id).toBe('ref-1');
    expect(mockPrisma.mediaVersion.findUnique).toHaveBeenCalledTimes(3);
  });

  it('ref 变 failed → 抛错且错误信息含 refId', async () => {
    mockPrisma.mediaVersion.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'failed',
      filePath: null,
    });

    await expect(processor.waitForRef('ref-1', 10, 1_000)).rejects.toThrow(/ref-1/);
  });

  it('超时 → 抛错且错误信息含 refId', async () => {
    // 始终返回 generating，直到超时
    mockPrisma.mediaVersion.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'generating',
      filePath: null,
    });

    await expect(processor.waitForRef('ref-1', 10, 50)).rejects.toThrow(/ref-1/);
  });

  it('ref 不存在 → 抛错', async () => {
    mockPrisma.mediaVersion.findUnique.mockResolvedValue(null);

    await expect(processor.waitForRef('ref-ghost', 10, 1_000)).rejects.toThrow(/ref-ghost/);
  });
});
