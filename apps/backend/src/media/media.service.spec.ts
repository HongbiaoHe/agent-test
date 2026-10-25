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
import {
  AbortRegistry,
  MEDIA_ABORTS,
  MEDIA_PAUSES,
} from '../agent/abort-registry';
import { AigcService } from '../aigc/aigc.service';
import { PublicUrlService } from '../aigc/public-url.service';
import { asAssetType, MediaService } from './media.service';
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
    updateMany: jest.fn(),
  },
  // 触发时判定是否走测试模式：查不到画布行 = Spark 会话 / 未开 Mock，恒为真实生成
  canvasSession: { findUnique: jest.fn().mockResolvedValue(null) },
};
const mockQueue = { add: jest.fn() };
const mockStream = { publish: jest.fn() };
/** 模型选择在建版本时经 aigc 目录归一；单测里给一个固定的返回即可。 */
const mockAigc = {
  resolveConfig: jest.fn().mockResolvedValue({
    channel: 'byteplus',
    model: 'seedream-4.5',
    params: { aspect_ratio: '16:9', resolution: '2K' },
  }),
};
const mockPublicUrl = { baseUrl: jest.fn().mockResolvedValue(null) };

describe('MediaService', () => {
  let service: MediaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: mockQueue },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: getQueueToken('media-poll'), useValue: { add: jest.fn() } },
        { provide: MEDIA_PAUSES, useValue: new AbortRegistry() },
        { provide: AigcService, useValue: mockAigc },
        { provide: PublicUrlService, useValue: mockPublicUrl },
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

      const r = await service.createGeneration(
        'conv-1',
        'user-1',
        'image',
        '一只猫',
      );

      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      // version 以 queued 状态创建
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId: 'conv-1',
            userId: 'user-1',
            type: 'image',
            versions: {
              create: expect.objectContaining({
                status: 'queued',
                prompt: '一只猫',
              }),
            },
          }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        'generate',
        { versionId: 'ver-1' },
        { jobId: 'ver-1' },
      );
      // 入队后推 queued 事件
      expect(mockStream.publish).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          type: 'media_update',
          payload: expect.objectContaining({
            generationId: 'gen-1',
            versionId: 'ver-1',
            status: 'queued',
          }),
        }),
      );
    });
  });

  /**
   * 画布测试模式（Mock）：以触发那一刻的开关为准、环境禁用时拒绝而不是悄悄改走真实生成、
   * 真实生成不能引用模拟产物、拼接成片继承模拟标记。
   */
  describe('测试模式（Mock）', () => {
    const savedFlag = process.env.CANVAS_MOCK_MEDIA_ENABLED;
    beforeEach(() => {
      process.env.CANVAS_MOCK_MEDIA_ENABLED = 'true';
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'canvas-1',
        type: 'video',
        versions: [{ id: 'ver-1' }],
      });
    });
    afterEach(() => {
      process.env.CANVAS_MOCK_MEDIA_ENABLED = savedFlag;
      mockPrisma.canvasSession.findUnique.mockResolvedValue(null);
    });

    const ref = (id: string, mock: boolean) => ({
      id,
      status: 'done',
      mock,
      generation: { type: 'image', userId: 'user-1' },
    });
    const versionCreate = () =>
      expect.objectContaining({
        data: expect.objectContaining({
          versions: { create: expect.objectContaining({ mock: true }) },
        }),
      });

    it('画布开着 Mock → 版本记为 mock（照常入队，由 worker 走模拟分支）', async () => {
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        mockMedia: true,
      });
      await service.createGeneration('canvas-1', 'user-1', 'video', 'p');
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        versionCreate(),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        'generate',
        { versionId: 'ver-1' },
        { jobId: 'ver-1' },
      );
    });

    it('开着 Mock 但环境禁用 → CANVAS_MOCK_DISABLED，不建版本、绝不改走真实生成', async () => {
      process.env.CANVAS_MOCK_MEDIA_ENABLED = 'false';
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        mockMedia: true,
      });
      await expect(
        service.createGeneration('canvas-1', 'user-1', 'video', 'p'),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.CANVAS_MOCK_DISABLED.code,
      });
      expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('真实生成引用模拟产物 → MEDIA_REF_MOCK，不建版本', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([ref('r1', true)]);
      await expect(
        service.createGeneration('canvas-1', 'user-1', 'video', 'p', ['r1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_MOCK.code });
      expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
    });

    it('模拟生成引用模拟产物 → 放行', async () => {
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        mockMedia: true,
      });
      mockPrisma.mediaVersion.findMany.mockResolvedValue([ref('r1', true)]);
      await service.createGeneration('canvas-1', 'user-1', 'video', 'p', [
        'r1',
      ]);
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        versionCreate(),
      );
    });

    it('重试也按此刻的开关：画布开着 Mock → 新版本记为 mock', async () => {
      mockPrisma.canvasSession.findUnique.mockResolvedValue({
        mockMedia: true,
      });
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        userId: 'user-1',
        conversationId: 'canvas-1',
        type: 'video',
        versions: [
          {
            prompt: 'p',
            model: 'seedance-2',
            channel: 'byteplus',
            params: {},
            referenceVersionIds: null,
          },
        ],
      });
      mockPrisma.mediaVersion.create.mockResolvedValue({ id: 'ver-2' });
      await service.regenerate('gen-1', 'user-1');
      expect(mockPrisma.mediaVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mock: true }),
      });
    });

    it('拼接源里有模拟产物 → 成片也记为 mock（拼接本身照常执行）', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'a',
          status: 'done',
          filePath: 'a.mp4',
          url: null,
          mock: true,
          generation: { type: 'video', userId: 'user-1' },
        },
        {
          id: 'b',
          status: 'done',
          filePath: null,
          url: 'https://cdn/b.mp4',
          mock: false,
          generation: { type: 'video', userId: 'user-1' },
        },
      ]);
      await service.createConcat('canvas-1', 'user-1', ['a', 'b']);
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        versionCreate(),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        'concat',
        { versionId: 'ver-1' },
        { jobId: 'ver-1' },
      );
    });
  });

  describe('createConcat 的源状态', () => {
    const src = (id: string, status: string, filePath: string | null) => ({
      id,
      status,
      filePath,
      url: null,
      mock: false,
      generation: { type: 'video', userId: 'user-1' },
    });

    it('源还在排队 / 生成：照收（worker 等齐再拼）', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        src('a', 'done', 'a.mp4'),
        src('b', 'queued', null),
        src('c', 'generating', null),
      ]);
      await service.createConcat('canvas-1', 'user-1', ['a', 'b', 'c']);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'concat',
        { versionId: 'ver-1' },
        { jobId: 'ver-1' },
      );
    });

    it.each(['failed', 'cancelled'])(
      '源已 %s：拒绝，不入队',
      async (status) => {
        mockPrisma.mediaVersion.findMany.mockResolvedValue([
          src('a', 'done', 'a.mp4'),
          src('b', status, null),
        ]);
        await expect(
          service.createConcat('canvas-1', 'user-1', ['a', 'b']),
        ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
        expect(mockQueue.add).not.toHaveBeenCalled();
      },
    );

    it('done 了却没有文件：拒绝', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        src('a', 'done', 'a.mp4'),
        src('b', 'done', null),
      ]);
      await expect(
        service.createConcat('canvas-1', 'user-1', ['a', 'b']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });
  });

  describe('commitAttachments（附件随消息转正）', () => {
    const staged = (id: string, type: string, filename: string) => ({
      id,
      prompt: filename,
      url: `https://cdn/${filename}`,
      params: { contentType: 'x/y', size: '1', aigcUploadId: 'u' },
      generation: { type },
    });

    it('全部合法：staged → done，按传入顺序返回附件摘要', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        staged('v2', 'audio', 'b.mp3'),
        staged('v1', 'image', 'a.png'),
      ]);
      const r = await service.commitAttachments('conv-1', 'user-1', [
        'v1',
        'v2',
      ]);
      expect(mockPrisma.mediaVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['v1', 'v2'] },
            model: 'upload',
            status: 'staged',
            generation: { conversationId: 'conv-1', userId: 'user-1' },
          },
        }),
      );
      expect(mockPrisma.mediaVersion.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['v1', 'v2'] }, status: 'staged' },
        data: { status: 'done' },
      });
      expect(r.map((a) => [a.versionId, a.type, a.filename])).toEqual([
        ['v1', 'image', 'a.png'],
        ['v2', 'audio', 'b.mp3'],
      ]);
    });

    it('有一个不合法（别的会话 / 已发过 / 不存在）→ 整体拒绝，一个都不改', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        staged('v1', 'image', 'a.png'),
      ]);
      await expect(
        service.commitAttachments('conv-1', 'user-1', ['v1', 'v-other']),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_ATTACHMENT_INVALID.code,
      });
      expect(mockPrisma.mediaVersion.updateMany).not.toHaveBeenCalled();
    });

    it('没带附件：不查库', async () => {
      expect(await service.commitAttachments('c', 'u', [])).toEqual([]);
      expect(mockPrisma.mediaVersion.findMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveSandboxSources（同步进沙箱前的解析）', () => {
    const row = (over: Record<string, unknown>) => ({
      id: 'v',
      status: 'done',
      model: 'seedance-2',
      prompt: '提示词',
      url: 'https://cdn/x.mp4',
      filePath: null,
      generation: { type: 'video', conversationId: 'conv-1', userId: 'user-1' },
      ...over,
    });

    it('上传的用原始文件名、生成的用 <type>.<ext>；别的会话 / 未完成的单独报原因', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        row({ id: 'gen', url: 'https://cdn/out.mp4' }),
        row({
          id: 'up',
          model: 'upload',
          prompt: 'cat.png',
          url: 'https://cdn/cat.png',
          generation: {
            type: 'image',
            conversationId: 'conv-1',
            userId: 'user-1',
          },
        }),
        row({ id: 'busy', status: 'generating', url: null }),
        row({
          id: 'foreign',
          generation: {
            type: 'video',
            conversationId: 'conv-2',
            userId: 'user-1',
          },
        }),
      ]);
      const r = await service.resolveSandboxSources('conv-1', 'user-1', [
        'gen',
        'up',
        'busy',
        'foreign',
        'missing',
      ]);
      expect(r.sources).toEqual([
        {
          versionId: 'gen',
          type: 'video',
          filename: 'video.mp4',
          url: 'https://cdn/out.mp4',
          filePath: null,
        },
        {
          versionId: 'up',
          type: 'image',
          filename: 'cat.png',
          url: 'https://cdn/cat.png',
          filePath: null,
        },
      ]);
      expect(r.errors.map((e) => e.versionId)).toEqual([
        'busy',
        'foreign',
        'missing',
      ]);
      expect(r.errors[0].reason).toContain('status=generating');
    });
  });

  describe('listForConversation', () => {
    it('排除还没随消息发出的上传（staged）', async () => {
      mockPrisma.mediaGeneration.findMany.mockResolvedValue([]);
      await service.listForConversation('conv-1', 'user-1');
      expect(mockPrisma.mediaGeneration.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId: 'conv-1',
            userId: 'user-1',
            versions: { none: { status: 'staged' } },
          },
        }),
      );
    });
  });

  describe('regenerate', () => {
    it('用户上传的素材不能重新生成 → MEDIA_NOT_REGENERABLE', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-up',
        conversationId: 'conv-1',
        userId: 'user-1',
        type: 'image',
        versions: [{ id: 'ver-up', prompt: 'a.png', model: 'upload' }],
      });
      await expect(
        service.regenerate('gen-up', 'user-1'),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_NOT_REGENERABLE.code,
      });
      expect(mockPrisma.mediaVersion.create).not.toHaveBeenCalled();
    });

    it('在同 generation 下建新版本（旧版本不动）并沿用上一版 prompt', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        type: 'image',
        versions: [
          {
            id: 'ver-old',
            prompt: '旧提示词',
            model: 'gemini-3.1-flash-image-preview',
          },
        ],
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
      expect(mockQueue.add).toHaveBeenCalledWith(
        'generate',
        { versionId: 'ver-new' },
        { jobId: 'ver-new' },
      );
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
        expect.objectContaining({
          data: expect.objectContaining({ prompt: '新提示词' }),
        }),
      );
    });

    it('外部用户 regenerate 抛出 NOT_FOUND', async () => {
      mockPrisma.mediaGeneration.findUnique.mockResolvedValue({
        id: 'gen-1',
        userId: 'owner',
        type: 'image',
        versions: [{ id: 'ver-old', prompt: 'p', model: 'm' }],
      });

      await expect(
        service.regenerate('gen-1', 'attacker'),
      ).rejects.toMatchObject({
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
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        okRef('ref-1'),
        okRef('ref-2'),
      ]);
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        type: 'image',
        versions: [{ id: 'ver-1' }],
      });

      const r = await service.createGeneration(
        'conv-1',
        'user-1',
        'image',
        '改图',
        ['ref-1', 'ref-2'],
      );

      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      // 落库：referenceVersionIds 写到新 version 行
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            versions: {
              create: expect.objectContaining({
                referenceVersionIds: ['ref-1', 'ref-2'],
              }),
            },
          }),
        }),
      );
    });

    it('参考版本不存在 → MEDIA_REF_INVALID（不建 generation）', async () => {
      // 传 2 个 id 但只查到 1 个
      mockPrisma.mediaVersion.findMany.mockResolvedValue([okRef('ref-1')]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', [
          'ref-1',
          'ref-missing',
        ]),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
      expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
    });

    it('参考版本 queued → 校验通过（就绪性由 processor 等待）', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'queued',
          generation: { type: 'image', userId: 'user-1' },
        },
      ]);
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        type: 'video',
        versions: [{ id: 'ver-1' }],
      });

      const r = await service.createGeneration(
        'conv-1',
        'user-1',
        'video',
        '霓虹水母视频',
        ['ref-1'],
      );
      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalled();
    });

    it('参考版本 generating → 校验通过（就绪性由 processor 等待）', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'generating',
          generation: { type: 'image', userId: 'user-1' },
        },
      ]);
      mockPrisma.mediaGeneration.create.mockResolvedValue({
        id: 'gen-1',
        conversationId: 'conv-1',
        type: 'video',
        versions: [{ id: 'ver-1' }],
      });

      const r = await service.createGeneration(
        'conv-1',
        'user-1',
        'video',
        '霓虹水母视频',
        ['ref-1'],
      );
      expect(r).toEqual({ generationId: 'gen-1', versionId: 'ver-1' });
      expect(mockPrisma.mediaGeneration.create).toHaveBeenCalled();
    });

    it('参考版本 failed → MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'failed',
          generation: { type: 'image', userId: 'user-1' },
        },
      ]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'video', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
      expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
    });

    it('参考版本不是 image / video / audio 资产 → MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'done',
          generation: { type: 'text', userId: 'user-1' },
        },
      ]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });

    it('上传了还没随消息发出的附件（staged）→ MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'staged',
          generation: { type: 'image', userId: 'user-1' },
        },
      ]);

      await expect(
        service.createGeneration('conv-1', 'user-1', 'image', 'p', ['ref-1']),
      ).rejects.toMatchObject({ errCode: ErrorCodes.MEDIA_REF_INVALID.code });
    });

    it('参考版本属于他人 → MEDIA_REF_INVALID', async () => {
      mockPrisma.mediaVersion.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: 'done',
          generation: { type: 'image', userId: 'owner' },
        },
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

      await expect(
        service.getVersionAsset('ver-1', 'attacker'),
      ).rejects.toMatchObject({
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

      await expect(
        service.getVersionAsset('ver-1', 'user-1'),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_ASSET_NOT_READY.code,
      });
    });
  });

  describe('getVersionSource', () => {
    it('aigc 产物 → 返回 CDN 地址', async () => {
      mockPrisma.mediaVersion.findUnique.mockResolvedValue({
        id: 'ver-1',
        status: 'done',
        url: 'https://cdn/x.jpg',
        filePath: null,
        generation: { userId: 'user-1' },
      });
      await expect(
        service.getVersionSource('ver-1', 'user-1'),
      ).resolves.toEqual({ url: 'https://cdn/x.jpg' });
    });

    it('只有本地文件（拼接产物）→ url 为 null，由前端改走 asset 接口', async () => {
      mockPrisma.mediaVersion.findUnique.mockResolvedValue({
        id: 'ver-1',
        status: 'done',
        url: null,
        filePath: 'ver-1.mp4',
        generation: { userId: 'user-1' },
      });
      await expect(
        service.getVersionSource('ver-1', 'user-1'),
      ).resolves.toEqual({ url: null });
    });

    it('外部用户 → NOT_FOUND；未完成 → NOT_READY', async () => {
      mockPrisma.mediaVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-1',
        status: 'done',
        url: 'https://cdn/x.jpg',
        filePath: null,
        generation: { userId: 'owner' },
      });
      await expect(
        service.getVersionSource('ver-1', 'attacker'),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_VERSION_NOT_FOUND.code,
      });

      mockPrisma.mediaVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-1',
        status: 'generating',
        url: null,
        filePath: null,
        generation: { userId: 'user-1' },
      });
      await expect(
        service.getVersionSource('ver-1', 'user-1'),
      ).rejects.toMatchObject({
        errCode: ErrorCodes.MEDIA_ASSET_NOT_READY.code,
      });
    });
  });
});

describe('MediaService – cancelByConversation（停止功能）', () => {
  let service: MediaService;
  let aborts: AbortRegistry;
  const findManyVersions = jest.fn();
  const updateVersion = jest.fn();
  const getJob = jest.fn();

  beforeEach(async () => {
    aborts = new AbortRegistry();
    const prisma = {
      mediaVersion: { findMany: findManyVersions, update: updateVersion },
    };
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StreamService, useValue: mockStream },
        {
          provide: getQueueToken('media-gen'),
          useValue: { add: jest.fn(), getJob },
        },
        { provide: getQueueToken('media-poll'), useValue: { add: jest.fn() } },
        { provide: MEDIA_ABORTS, useValue: aborts },
        { provide: MEDIA_PAUSES, useValue: new AbortRegistry() },
        { provide: AigcService, useValue: mockAigc },
        { provide: PublicUrlService, useValue: mockPublicUrl },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  const gen = { type: 'image' };

  it('queued 版本：移除 job + 置 cancelled(用户已停止) + 推流', async () => {
    const remove = jest.fn();
    getJob.mockResolvedValue({ remove });
    findManyVersions.mockResolvedValue([
      { id: 'v1', status: 'queued', generationId: 'g1', generation: gen },
    ]);

    await service.cancelByConversation('conv-1');

    expect(remove).toHaveBeenCalled();
    expect(updateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'v1' },
        data: expect.objectContaining({
          status: 'cancelled',
          error: '用户已停止',
        }),
      }),
    );
    expect(mockStream.publish).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        payload: expect.objectContaining({
          versionId: 'v1',
          status: 'cancelled',
        }),
      }),
    );
  });

  it('generating 版本：协作 abort（signal 变 aborted），不直接改库', async () => {
    const { signal } = aborts.register('v2');
    findManyVersions.mockResolvedValue([
      { id: 'v2', status: 'generating', generationId: 'g1', generation: gen },
    ]);

    await service.cancelByConversation('conv-1');

    expect(signal.aborted).toBe(true);
    expect(updateVersion).not.toHaveBeenCalled();
  });

  it('queued 但 remove 抛错（刚被拾取为 active）→ 落到协作 abort 分支', async () => {
    getJob.mockResolvedValue({
      remove: jest.fn().mockRejectedValue(new Error('locked')),
    });
    const { signal } = aborts.register('v3');
    findManyVersions.mockResolvedValue([
      { id: 'v3', status: 'queued', generationId: 'g1', generation: gen },
    ]);

    await service.cancelByConversation('conv-1');

    expect(signal.aborted).toBe(true);
    expect(updateVersion).not.toHaveBeenCalled();
  });
});

describe('MediaService – 暂停 / 继续', () => {
  let service: MediaService;
  let pauses: AbortRegistry;
  const findManyVersions = jest.fn();
  const updateMany = jest.fn();
  const getJob = jest.fn();
  const add = jest.fn();

  beforeEach(async () => {
    pauses = new AbortRegistry();
    updateMany.mockResolvedValue({ count: 1 });
    const prisma = {
      mediaVersion: { findMany: findManyVersions, updateMany },
    };
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: { add, getJob } },
        { provide: getQueueToken('media-poll'), useValue: { add: jest.fn() } },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: MEDIA_PAUSES, useValue: pauses },
        { provide: AigcService, useValue: mockAigc },
        { provide: PublicUrlService, useValue: mockPublicUrl },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  const gen = { type: 'video', conversationId: 'conv-1' };
  const ver = (id: string, status: string, extra = {}) => ({
    id,
    status,
    generationId: `g-${id}`,
    providerTaskId: null,
    model: 'seedance-2',
    generation: gen,
    ...extra,
  });

  it('排队中：移出队列、落 paused 并推流', async () => {
    const remove = jest.fn();
    getJob.mockResolvedValue({ remove });
    findManyVersions.mockResolvedValue([ver('v1', 'queued')]);

    expect(await service.pauseVersions('conv-1')).toEqual({
      paused: 1,
      skipped: 0,
    });
    expect(remove).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', status: 'queued' },
      data: { status: 'paused' },
    });
    expect(mockStream.publish).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        payload: expect.objectContaining({ versionId: 'v1', status: 'paused' }),
      }),
    );
  });

  it('worker 还在等上游（没提交）：经暂停注册表叫停，由 worker 收尾', async () => {
    const { signal } = pauses.register('v2');
    findManyVersions.mockResolvedValue([ver('v2', 'generating')]);

    expect(await service.pauseVersions('conv-1')).toEqual({
      paused: 1,
      skipped: 0,
    });
    expect(signal.aborted).toBe(true);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('已经提交给 aigc / 已过暂停窗口：跳过，照常完成', async () => {
    findManyVersions.mockResolvedValue([
      ver('v3', 'generating', { providerTaskId: 'task-1' }),
      ver('v4', 'generating'), // 没登记暂停窗口（如正在本地出片）
    ]);

    expect(await service.pauseVersions('conv-1')).toEqual({
      paused: 0,
      skipped: 2,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('只暂停传入的版本（画布按节点暂停）', async () => {
    findManyVersions.mockResolvedValue([]);
    await service.pauseVersions('conv-1', ['v1', 'v2']);
    expect(findManyVersions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['v1', 'v2'] } }),
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('继续：按创建顺序清掉旧 job、改回 queued、按类型重新入队', async () => {
    getJob.mockResolvedValueOnce({ remove: jest.fn() }).mockResolvedValue(null);
    findManyVersions.mockResolvedValue([
      ver('v1', 'paused'),
      ver('v2', 'paused', { model: 'ffmpeg-concat' }),
    ]);

    expect(await service.resumeVersions('conv-1')).toEqual({ resumed: 2 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', status: 'paused' },
      data: { status: 'queued' },
    });
    expect(add.mock.calls).toEqual([
      ['generate', { versionId: 'v1' }, { jobId: 'v1' }],
      ['concat', { versionId: 'v2' }, { jobId: 'v2' }],
    ]);
  });

  it('继续时状态已变（被并发改走）：不重复入队', async () => {
    getJob.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 0 });
    findManyVersions.mockResolvedValue([ver('v1', 'paused')]);

    expect(await service.resumeVersions('conv-1')).toEqual({ resumed: 0 });
    expect(add).not.toHaveBeenCalled();
  });

  it('停止会把暂停中的一并作废', async () => {
    findManyVersions.mockResolvedValue([ver('v5', 'paused')]);
    await service.cancelByConversation('conv-1');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'v5', status: 'paused' },
      data: expect.objectContaining({
        status: 'cancelled',
        error: '用户已停止',
      }),
    });
  });
});

describe('MediaService.createAgentGenerations', () => {
  let service: MediaService;
  const prepareAgentGeneration = jest.fn();
  const config = {
    channel: 'google',
    model: 'veo-3.1',
    params: { aspect_ratio: '16:9', duration: '8', resolution: '1080p' },
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: mockQueue },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: getQueueToken('media-poll'), useValue: { add: jest.fn() } },
        { provide: MEDIA_PAUSES, useValue: new AbortRegistry() },
        {
          provide: AigcService,
          useValue: { ...mockAigc, prepareAgentGeneration },
        },
        { provide: PublicUrlService, useValue: mockPublicUrl },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('count 越界 → issues，不查目录也不建库', async () => {
    for (const count of [0, 11, 1.5]) {
      const r = await service.createAgentGenerations('c', 'u', 'image', {
        prompt: 'p',
        count,
      });
      expect(r).toMatchObject({ ok: false, issues: [{ field: 'count' }] });
    }
    expect(prepareAgentGeneration).not.toHaveBeenCalled();
    expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
  });

  it('目录校验不通过 → 原样返回 issues，不建库不入队', async () => {
    const issues = [{ field: 'params.duration', message: 'x' }];
    prepareAgentGeneration.mockResolvedValue({ ok: false, issues });
    // 一张图 + 一段上传的视频：按类型计数后交给目录校验
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      { id: 'r1', status: 'done', generation: { type: 'image', userId: 'u' } },
      { id: 'r2', status: 'done', generation: { type: 'video', userId: 'u' } },
    ]);
    const r = await service.createAgentGenerations('c', 'u', 'video', {
      prompt: 'p',
      model: 'veo-3.1',
      params: { duration: '4' },
      referenceVersionIds: ['r1', 'r2'],
      count: 1,
    });
    expect(r).toEqual({ ok: false, issues });
    expect(prepareAgentGeneration).toHaveBeenCalledWith('video', {
      model: 'veo-3.1',
      channel: undefined,
      params: { duration: '4' },
      prompt: 'p',
      referenceCounts: { image: 1, video: 1, audio: 0 },
    });
    expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('通过 → 按 count 建 N 个独立生成位，模型取校验后的 config', async () => {
    prepareAgentGeneration.mockResolvedValue({ ok: true, config });
    mockAigc.resolveConfig.mockResolvedValue(config);
    let n = 0;
    mockPrisma.mediaGeneration.create.mockImplementation(() => {
      n++;
      return Promise.resolve({
        id: `gen-${n}`,
        conversationId: 'c',
        type: 'video',
        versions: [{ id: `ver-${n}` }],
      });
    });

    const r = await service.createAgentGenerations('c', 'u', 'video', {
      prompt: 'p',
      count: 3,
    });

    expect(r).toEqual({
      ok: true,
      config,
      generations: [
        { generationId: 'gen-1', versionId: 'ver-1' },
        { generationId: 'gen-2', versionId: 'ver-2' },
        { generationId: 'gen-3', versionId: 'ver-3' },
      ],
    });
    expect(mockAigc.resolveConfig).toHaveBeenCalledWith('video', config);
    expect(mockQueue.add).toHaveBeenCalledTimes(3);
    expect(mockStream.publish).toHaveBeenCalledTimes(3);
  });
});

describe('MediaService：配音参考格式 / 克隆音色 / 我的音色', () => {
  let service: MediaService;
  const prepareAgentGeneration = jest.fn();

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: mockQueue },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: getQueueToken('media-poll'), useValue: { add: jest.fn() } },
        { provide: MEDIA_PAUSES, useValue: new AbortRegistry() },
        {
          provide: AigcService,
          useValue: { ...mockAigc, prepareAgentGeneration },
        },
        { provide: PublicUrlService, useValue: mockPublicUrl },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('asAssetType：voice 按 audio 处理', () => {
    expect(asAssetType('voice')).toBe('audio');
    expect(asAssetType('audio')).toBe('audio');
    expect(asAssetType('nope')).toBeNull();
  });

  it('配音引用 .m4a 录音 → issues 提示先 clone_voice，不查目录不建库', async () => {
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      {
        id: 'up-1',
        status: 'done',
        model: 'upload',
        prompt: 'my-voice.m4a',
        url: 'https://gcs/u/abc.m4a',
        generation: { type: 'audio', userId: 'u' },
      },
    ]);
    const r = await service.createAgentGenerations('c', 'u', 'audio', {
      prompt: '你好',
      referenceVersionIds: ['up-1'],
      count: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('clone_voice');
    expect(prepareAgentGeneration).not.toHaveBeenCalled();
    expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
  });

  it('配音引用克隆产物（voice，.wav）→ 正常交给目录校验，按 audio 计数', async () => {
    prepareAgentGeneration.mockResolvedValue({ ok: false, issues: [] });
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      {
        id: 'v-1',
        status: 'done',
        model: 'voice-replication-2.0',
        prompt: '示范文案',
        url: 'https://gcs/t/demo.wav',
        generation: { type: 'voice', userId: 'u' },
      },
    ]);
    await service.createAgentGenerations('c', 'u', 'audio', {
      prompt: '你好',
      model: 'seed-audio-1.0',
      referenceVersionIds: ['v-1'],
      count: 1,
    });
    expect(prepareAgentGeneration).toHaveBeenCalledWith(
      'audio',
      expect.objectContaining({
        referenceCounts: { image: 0, video: 0, audio: 1 },
      }),
    );
  });

  it('createVoiceClone：固定 byteplus 模型，源录音进 referenceVersionIds，建 voice 生成位', async () => {
    const config = {
      channel: 'byteplus',
      model: 'voice-replication-2.0',
      params: { language: '0' },
    };
    prepareAgentGeneration.mockResolvedValue({ ok: true, config });
    mockAigc.resolveConfig.mockResolvedValue(config);
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      {
        id: 'up-1',
        status: 'done',
        generation: { type: 'audio', userId: 'u' },
      },
    ]);
    mockPrisma.mediaGeneration.create.mockResolvedValue({
      id: 'gen-v',
      conversationId: 'c',
      type: 'voice',
      versions: [{ id: 'ver-v' }],
    });

    const r = await service.createVoiceClone('c', 'u', {
      sourceVersionId: 'up-1',
      language: '0',
      demoText: '今天天气真不错',
    });

    expect(r).toEqual({
      ok: true,
      config,
      generation: { generationId: 'gen-v', versionId: 'ver-v' },
    });
    expect(prepareAgentGeneration).toHaveBeenCalledWith('voice', {
      model: 'voice-replication-2.0',
      channel: 'byteplus',
      params: { language: '0' },
      prompt: '今天天气真不错',
      referenceCounts: { image: 0, video: 0, audio: 0 },
    });
    expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'voice',
          versions: {
            create: expect.objectContaining({
              prompt: '今天天气真不错',
              referenceVersionIds: ['up-1'],
            }),
          },
        }),
      }),
    );
  });

  it('createVoiceClone：源素材不是音频、文案太短 → issues，不建库', async () => {
    prepareAgentGeneration.mockResolvedValue({ ok: true, config: {} });
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      {
        id: 'img-1',
        status: 'done',
        generation: { type: 'image', userId: 'u' },
      },
    ]);
    const r = await service.createVoiceClone('c', 'u', {
      sourceVersionId: 'img-1',
      language: '0',
      demoText: '你好',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field)).toEqual([
      'sourceVersionId',
      'demoText',
    ]);
    expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
  });

  it('listMyVoices：只查本人 done 的 voice，每个生成位取最新版本', async () => {
    const at = new Date('2026-10-24T08:00:00Z');
    mockPrisma.mediaVersion.findMany.mockResolvedValue([
      {
        id: 'v-new',
        generationId: 'g-1',
        prompt: '新版',
        params: { language: '0' },
        createdAt: at,
      },
      {
        id: 'v-old',
        generationId: 'g-1',
        prompt: '旧版',
        params: {},
        createdAt: at,
      },
      {
        id: 'v-2',
        generationId: 'g-2',
        prompt: 'hello there',
        params: { language: '1' },
        createdAt: at,
      },
    ]);
    const voices = await service.listMyVoices('u');
    expect(mockPrisma.mediaVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'done', generation: { userId: 'u', type: 'voice' } },
      }),
    );
    expect(voices.map((v) => v.versionId)).toEqual(['v-new', 'v-2']);
    expect(voices[0]).toEqual({
      versionId: 'v-new',
      demoText: '新版',
      language: '0',
      createdAt: at.toISOString(),
    });
  });
});

describe('MediaService 对账（media-poll 队列）', () => {
  const pollQueue = { add: jest.fn() };
  const findUnique = jest.fn();
  const getTask = jest.fn();
  let service: MediaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        {
          provide: PrismaService,
          useValue: {
            ...mockPrisma,
            mediaVersion: { ...mockPrisma.mediaVersion, findUnique },
          },
        },
        { provide: StreamService, useValue: mockStream },
        { provide: getQueueToken('media-gen'), useValue: mockQueue },
        { provide: getQueueToken('media-poll'), useValue: pollQueue },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: MEDIA_PAUSES, useValue: new AbortRegistry() },
        { provide: AigcService, useValue: { ...mockAigc, getTask } },
        { provide: PublicUrlService, useValue: mockPublicUrl },
      ],
    }).compile();
    service = module.get(MediaService);
    jest.clearAllMocks();
  });

  it('对账排在 media-poll，不进生成队列；前 6 轮 10s，之后 30s', async () => {
    await service.scheduleReconcile('v1', 6);
    await service.scheduleReconcile('v1', 7);

    // 生成队列的槽位可能全被等上游的下游占着，对账排在那里会永远轮不到
    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(pollQueue.add).toHaveBeenNthCalledWith(
      1,
      'poll',
      { versionId: 'v1', attempt: 6 },
      expect.objectContaining({ delay: 10_000 }),
    );
    expect(pollQueue.add).toHaveBeenNthCalledWith(
      2,
      'poll',
      { versionId: 'v1', attempt: 7 },
      expect.objectContaining({ delay: 30_000 }),
    );
  });

  const open = {
    id: 'v1',
    status: 'generating',
    providerTaskId: 'task-1',
    generationId: 'g1',
    generation: { conversationId: 'c1', type: 'image' },
  };

  it('aigc 还没出结果：排下一轮', async () => {
    findUnique.mockResolvedValue(open);
    getTask.mockResolvedValue({ task_id: 'task-1', status: 'processing' });
    jest.spyOn(service, 'applyTaskResult').mockResolvedValue('pending');

    await service.reconcile('v1', 3);

    expect(pollQueue.add).toHaveBeenCalledWith(
      'poll',
      { versionId: 'v1', attempt: 4 },
      expect.anything(),
    );
  });

  it('aigc 已出结果：落库，不再排', async () => {
    findUnique.mockResolvedValue(open);
    getTask.mockResolvedValue({ task_id: 'task-1', status: 'success' });
    const apply = jest
      .spyOn(service, 'applyTaskResult')
      .mockResolvedValue('applied');

    await service.reconcile('v1', 1);

    expect(apply).toHaveBeenCalledWith({
      task_id: 'task-1',
      status: 'success',
    });
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('查询失败不判死：照样排下一轮', async () => {
    findUnique.mockResolvedValue(open);
    getTask.mockRejectedValue(new Error('socket hang up'));

    await service.reconcile('v1', 2);

    expect(pollQueue.add).toHaveBeenCalledWith(
      'poll',
      { versionId: 'v1', attempt: 3 },
      expect.anything(),
    );
  });

  it('轮满仍无结果：判超时失败', async () => {
    findUnique.mockResolvedValue(open);
    getTask.mockResolvedValue({ task_id: 'task-1', status: 'processing' });
    jest.spyOn(service, 'applyTaskResult').mockResolvedValue('pending');
    const settle = jest
      .spyOn(service, 'settleFailed')
      .mockResolvedValue('applied');

    await service.reconcile('v1', 60);

    expect(settle).toHaveBeenCalledWith(
      'v1',
      'g1',
      'c1',
      'image',
      '生成超时：aigc 长时间未回结果',
    );
    expect(pollQueue.add).not.toHaveBeenCalled();
  });

  it('版本已终结：什么都不做', async () => {
    findUnique.mockResolvedValue({ ...open, status: 'done' });

    await service.reconcile('v1', 1);

    expect(getTask).not.toHaveBeenCalled();
    expect(pollQueue.add).not.toHaveBeenCalled();
  });
});
