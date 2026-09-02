/**
 * aigc 回调收尾的单元测试（MediaService.applyTaskResult + 纯函数）。
 *
 * 覆盖：completed 时转存产物并置 done、failed 时把渠道原码原话落库、重复回调被状态条件挡掉、
 * 以及签名/扩展名/Json 参数这几个边界纯函数。
 */
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortRegistry, MEDIA_ABORTS } from '../agent/abort-registry';
import { AigcService } from '../aigc/aigc.service';
import { PublicUrlService } from '../aigc/public-url.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { extFromUrl, MediaService, readParams } from './media.service';
import { signAssetToken, verifyAssetToken } from './media-asset-token';
import { pickHttpsTunnel } from '../aigc/public-url.service';

describe('extFromUrl', () => {
  it('取 URL 上的真后缀', () => {
    expect(extFromUrl('https://x/a/b.png', 'image')).toBe('png');
    expect(extFromUrl('https://x/a/b.mp4', 'video')).toBe('mp4');
    expect(extFromUrl('https://x/a/b.jpg?sig=1', 'image')).toBe('jpg');
  });
  it('认不出时按类型兜底', () => {
    expect(extFromUrl('https://x/a/b', 'image')).toBe('png');
    expect(extFromUrl('https://x/a/b', 'video')).toBe('mp4');
    // 不在白名单里的后缀不采纳（避免拿一段路径片段当扩展名）
    expect(extFromUrl('https://x/a/b.bin', 'image')).toBe('png');
  });
});

describe('readParams', () => {
  it('只保留字符串值', () =>
    expect(readParams({ a: '1', b: 2, c: null })).toEqual({ a: '1' }));
  it('非对象一律空', () => {
    expect(readParams(null)).toEqual({});
    expect(readParams(['a'])).toEqual({});
    expect(readParams('x')).toEqual({});
  });
});

describe('资产签名', () => {
  const prev = process.env.AUTH_JWT_SECRET;
  beforeAll(() => (process.env.AUTH_JWT_SECRET = 'test-secret'));
  afterAll(() => (process.env.AUTH_JWT_SECRET = prev));

  it('同一 versionId 稳定、不同 versionId 不同', () => {
    expect(signAssetToken('v1')).toBe(signAssetToken('v1'));
    expect(signAssetToken('v1')).not.toBe(signAssetToken('v2'));
  });
  it('校验只认自己签的', () => {
    expect(verifyAssetToken('v1', signAssetToken('v1'))).toBe(true);
    expect(verifyAssetToken('v1', signAssetToken('v2'))).toBe(false);
    expect(verifyAssetToken('v1', 'short')).toBe(false);
  });
});

describe('pickHttpsTunnel', () => {
  it('转发到前端 3100 时补反代前缀', () => {
    expect(
      pickHttpsTunnel({
        tunnels: [
          {
            proto: 'https',
            public_url: 'https://abc.ngrok-free.app',
            config: { addr: 'http://localhost:3100' },
          },
        ],
      }),
    ).toBe('https://abc.ngrok-free.app/api-backend');
  });
  it('直连后端端口时不加前缀，且跳过非 https', () => {
    expect(
      pickHttpsTunnel({
        tunnels: [
          { proto: 'http', public_url: 'http://abc.ngrok-free.app' },
          {
            proto: 'https',
            public_url: 'https://abc.ngrok-free.app',
            config: { addr: 'http://localhost:3101' },
          },
        ],
      }),
    ).toBe('https://abc.ngrok-free.app');
  });
  it('形状不符 → null', () => {
    expect(pickHttpsTunnel({})).toBeNull();
    expect(pickHttpsTunnel(null)).toBeNull();
  });
});

describe('MediaService.applyTaskResult', () => {
  const findFirst = jest.fn();
  const updateMany = jest.fn();
  const publish = jest.fn();
  let service: MediaService;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'media-cb-'));
    process.env.MEDIA_DATA_DIR = dir;
    const module = await Test.createTestingModule({
      providers: [
        MediaService,
        {
          provide: PrismaService,
          useValue: { mediaVersion: { findFirst, updateMany } },
        },
        { provide: StreamService, useValue: { publish } },
        { provide: getQueueToken('media-gen'), useValue: { add: jest.fn() } },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
        { provide: AigcService, useValue: {} },
        { provide: PublicUrlService, useValue: {} },
      ],
    }).compile();
    service = module.get(MediaService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEDIA_DATA_DIR;
  });

  const version = {
    id: 'ver-1',
    generationId: 'gen-1',
    status: 'generating',
    generation: { type: 'image', conversationId: 'canvas-1' },
  };

  it('completed：下载产物落盘 → done + 推流', async () => {
    findFirst.mockResolvedValue(version);
    updateMany.mockResolvedValue({ count: 1 });
    const bytes = Buffer.from('PNGDATA');
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(bytes, { status: 200 }));

    const r = await service.applyTaskResult({
      task_id: 't-1',
      status: 'completed',
      output_data: { image_url: 'https://gcs/x/out.png' },
    });

    expect(r).toBe('applied');
    expect(readFileSync(join(dir, 'ver-1.png')).toString()).toBe('PNGDATA');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'done',
          filePath: 'ver-1.png',
        }),
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      'canvas-1',
      expect.objectContaining({
        type: 'media_update',
        payload: expect.objectContaining({ status: 'done' }),
      }),
    );
  });

  it('failed：渠道原码 + 原话一起落库', async () => {
    findFirst.mockResolvedValue(version);
    updateMany.mockResolvedValue({ count: 1 });

    const r = await service.applyTaskResult({
      task_id: 't-1',
      status: 'failed',
      error_data: {
        code: 'InputTextSensitiveContentDetected',
        message: 'The input text may contain sensitive information.',
      },
    });

    expect(r).toBe('applied');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          error:
            'InputTextSensitiveContentDetected: The input text may contain sensitive information.',
        }),
      }),
    );
  });

  it('已终结的版本不再被回调改写（重复投递幂等）', async () => {
    findFirst.mockResolvedValue({ ...version, status: 'done' });
    const r = await service.applyTaskResult({
      task_id: 't-1',
      status: 'completed',
      output_data: { image_url: 'https://gcs/x/out.png' },
    });
    expect(r).toBe('ignored');
    expect(updateMany).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('与另一路抢跑时（updateMany 改到 0 行）不推流', async () => {
    findFirst.mockResolvedValue(version);
    updateMany.mockResolvedValue({ count: 0 });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(Buffer.from('x'), { status: 200 }));
    expect(
      await service.applyTaskResult({
        task_id: 't-1',
        status: 'completed',
        output_data: { image_url: 'https://gcs/x/out.png' },
      }),
    ).toBe('ignored');
    expect(publish).not.toHaveBeenCalled();
  });

  it('非终态 → pending（交给对账继续等）', async () => {
    findFirst.mockResolvedValue(version);
    expect(
      await service.applyTaskResult({ task_id: 't-1', status: 'processing' }),
    ).toBe('pending');
  });

  it('报成功但没有产物地址 → 判失败', async () => {
    findFirst.mockResolvedValue(version);
    updateMany.mockResolvedValue({ count: 1 });
    expect(
      await service.applyTaskResult({
        task_id: 't-1',
        status: 'completed',
        output_data: {},
      }),
    ).toBe('applied');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('找不到对应版本 → ignored', async () => {
    findFirst.mockResolvedValue(null);
    expect(
      await service.applyTaskResult({ task_id: 't-x', status: 'completed' }),
    ).toBe('ignored');
  });
});
