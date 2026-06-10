/**
 * MediaService 单元测试（mock Prisma / 队列 / StreamService）。
 *
 * 覆盖设计要求：
 * - createGeneration 建 generation+version、入队、推 queued 事件
 * - regenerate 保留旧版本（建新行而非改旧行）、prompt 缺省沿用上一版、拒绝外部用户
 * - getVersionAsset 拒绝外部用户
 */
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { ErrorCodes } from '../common/errors/error-code';

const mockPrisma = {
  mediaGeneration: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  mediaVersion: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};
const mockQueue = { add: jest.fn() };
const mockStream = { publish: jest.fn() };

describe('MediaService', () => {
  let service: MediaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: mockQueue },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createGeneration', () => {
    it('建 generation+version、入队 generate、推 queued 事件', async () => {
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        type: 'image',
        versions: [{ id: 'ver-1' }],
      });

      const r = await service.createGeneration('conv-1', 'user-1', 'image', '一只猫');

      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      // version 以 queued 状态创建
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId: 'conv-1',
            userId: 'user-1',
            type: 'image',
            versions: { create: expect.objectContaining({ status: 'queued', prompt: '一只猫' }) },
          }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith('generate', { versionId: 'ver-1' });
      // 入队后推 queued 事件
      expect(mockStream.publish).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          type: 'media_update',
          payload: expect.objectContaining({ generationId: 'gen-1', versionId: 'ver-1', status: 'queued' }),
        }),
      );
    });
  });

  describe('regenerate', () => {
    it('在同 generation 下建新版本（旧版本不动）并沿用上一版 prompt', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        type: 'image',
        versions: [{ id: 'ver-old', prompt: '旧提示词', model: 'gemini-3.1-flash-image-preview' }],
      });
      mockPrisma.mediaVersion.create.mockResolvedValue({ id: 'ver-new' });

      const r = await service.regenerate('gen-1', 'user-1');

      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-new' });
      // 建新版本行（不更新旧行）；prompt 缺省沿用上一版
      expect(mockPrisma.mediaVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            generationId: 'gen-1',
            prompt: '旧提示词',
            status: 'queued',
          }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith('generate', { versionId: 'ver-new' });
    });

    it('显式 prompt 覆盖上一版', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        type: 'image',
        versions: [{ id: 'ver-old', prompt: '旧提示词', model: 'm' }],
      });
      mockPrisma.mediaVersion.create.mockResolvedValue({ id: 'ver-new' });

      await service.regenerate('gen-1', 'user-1', '新提示词');

      expect(mockPrisma.mediaVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ prompt: '新提示词' }) }),
      );
    });

    it('外部用户 regenerate 抛出 NOT_FOUND', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        userId: 'owner',
        type: 'image',
        versions: [{ id: 'ver-old', prompt: 'p', model: 'm' }],
      });

      await expect(service.regenerate('gen-1', 'attacker')).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_GENERATION_NOT_FOUND.code,
      });
      expect(mockPrisma.mediaVersion.create).not.toHaveBeenCalled();
    });
  });

  describe('referenceVersionIds 校验', () => {
    // 合法参考：status=done、type=image、归属同 user
    function okRef(id: string) {
      return {
        id,
        status: 'done',
        generation: { type: 'image', userId: 'user-1' },
      };
    }

    it('createGeneration 合法参考通过并落库 referenceVersionIds', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([okRef('ref-1'), okRef('ref-2')]);
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        type: 'image',
        versions: [{ id: 'ver-1' }],
      });

      const r = await service.createGeneration('conv-1', 'user-1', 'image', '改图', [
        'ref-1',
        'ref-2',
      ]);

      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      // 落库：referenceVersionIds 写到新 version 行
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            versions: {
              create: expect.objectContaining({ referenceVersionIds: ['ref-1', 'ref-2'] }),
            },
          }),
        }),
      );
    });

    it('参考版本不存在 → MEDIA_REF_INVALID（不建 generation）', async () => {
      // 传 2 个 id 但只查到 1 个
      mockPrisma.mediaVersion.findMany.mockResolvedValue([okRef('ref-1')]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', ['ref-1', 'ref-missing']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
      expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
    });

    it('参考版本未完成（非 done）→ MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        { id: 'ref-1', status: 'generating', generation: { type: 'image', userId: 'user-1' } },
      ]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });

    it('参考版本非 image 类型（video）→ MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        { id: 'ref-1', status: 'done', generation: { type: 'video', userId: 'user-1' } },
      ]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });

    it('参考版本属于他人 → MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        { id: 'ref-1', status: 'done', generation: { type: 'image', userId: 'owner' } },
      ]);

      await expect(
        service.createGeneration('conv-1', 'attacker', 'image', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });

    it('regenerate 未传参考时继承上一版 referenceVersionIds', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        type: 'image',
        versions: [
          {
            id: 'ver-old',
            prompt: '旧提示词',
            model: 'm',
            referenceVersionIds: ['ref-1'],
          },
        ],
      });
      // 继承的参考仍需通过校验
      mockPrisma.mediaVersion.findMany.mockResolvedValue([okRef('ref-1')]);
      mockPrisma.mediaVersion.create.mockResolvedValue({ id: 'ver-new' });

      await service.regenerate('gen-1', 'user-1');

      expect(mockPrisma.mediaVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ referenceVersionIds: ['ref-1'] }),
        }),
      );
    });
  });

  describe('getVersionAsset', () => {
    it('外部用户取资产抛出 NOT_FOUND', async () => {
      mockPrisma.mediaVersion.findUnique.mockResolvedValue({
        id: 'ver-1',
        status: 'done',
        filePath: 'ver-1.png',
        generation: { userId: 'owner' },
      });

      await expect(service.getVersionAsset('ver-1', 'attacker')).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_VERSION_NOT_FOUND.code,
      });
    });

    it('未完成版本抛出 NOT_READY', async () => {
      mockPrisma.mediaVersion.findUnique.mockResolvedValue({
        id: 'ver-1',
        status: 'generating',
        filePath: null,
        generation: { userId: 'user-1' },
      });

      await expect(service.getVersionAsset('ver-1', 'user-1')).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_ASSET_NOT_READY.code,
      });
    });
  });
});
