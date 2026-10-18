/**
 * media.processor 单元测试：waitForRef 等待逻辑（参考图就绪性轮询）。
 */
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { AbortRegistry, MEDIA_ABORTS } from '../agent/abort-registry';
import { MediaProcessor } from './media.processor';
import { MediaService } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamService } from '../events/stream.service';
import { AigcService } from '../aigc/aigc.service';

describe('MediaProcessor.waitForRef', () => {
  const mockPrisma = { mediaVersion: { findUnique: jest.fn() } };
  const mockStream = { publish: jest.fn() };
  const mockAigc = {};
  const mockMedia = {};
  let processor: MediaProcessor;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: AigcService, useValue: mockAigc },
        { provide: MediaService, useValue: mockMedia },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
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
      .mockResolvedValueOnce({
        id: 'ref-1',
        status: 'generating',
        filePath: null,
      })
      .mockResolvedValueOnce({
        id: 'ref-1',
        status: 'done',
        filePath: 'ref-1.png',
      });

    const v = await processor.waitForRef('ref-1', 10, 5_000);
    expect(v.id).toBe('ref-1');
    expect(mockPrisma.mediaVersion.findUnique).toHaveBeenCalledTimes(2);
  });

  it('ref queued→done 后继续执行', async () => {
    mockPrisma.mediaVersion.findUnique
      .mockResolvedValueOnce({ id: 'ref-1', status: 'queued', filePath: null })
      .mockResolvedValueOnce({ id: 'ref-1', status: 'queued', filePath: null })
      .mockResolvedValueOnce({
        id: 'ref-1',
        status: 'done',
        filePath: 'ref-1.png',
      });

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

    await expect(processor.waitForRef('ref-1', 10, 1_000)).rejects.toThrow(
      /ref-1/,
    );
  });

  it('超时 → 抛错且错误信息含 refId', async () => {
    // 始终返回 generating，直到超时
    mockPrisma.mediaVersion.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'generating',
      filePath: null,
    });

    await expect(processor.waitForRef('ref-1', 10, 50)).rejects.toThrow(
      /ref-1/,
    );
  });

  it('ref 不存在 → 抛错', async () => {
    mockPrisma.mediaVersion.findUnique.mockResolvedValue(null);

    await expect(processor.waitForRef('ref-ghost', 10, 1_000)).rejects.toThrow(
      /ref-ghost/,
    );
  });
});

describe('MediaProcessor.process（generate）', () => {
  const version = {
    id: 'v1',
    prompt: 'p',
    model: 'nano-banana-pro',
    channel: 'google',
    params: { aspect_ratio: '16:9' },
    referenceVersionIds: null,
    generation: { id: 'g1', conversationId: 'c1', type: 'image' },
  };
  const mockPrisma = {
    mediaVersion: {
      findUnique: jest.fn().mockResolvedValue(version),
      update: jest.fn(),
    },
  };
  const mockStream = { publish: jest.fn() };
  const mockMedia = {
    callbackUrl: jest.fn().mockResolvedValue(undefined),
    markSubmitted: jest.fn(),
    scheduleReconcile: jest.fn(),
    settleFailed: jest.fn(),
  };
  let aborts: AbortRegistry;
  let processor: MediaProcessor;
  const submit = jest.fn();

  beforeEach(async () => {
    aborts = new AbortRegistry();
    const module = await Test.createTestingModule({
      providers: [
        MediaProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: mockStream },
        { provide: AigcService, useValue: { submit } },
        { provide: MediaService, useValue: mockMedia },
        { provide: MEDIA_ABORTS, useValue: aborts },
      ],
    }).compile();
    processor = module.get(MediaProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const job = { name: 'generate', data: { versionId: 'v1' } } as Job<{
    versionId: string;
  }>;

  it('正常提交 → 记 task_id 并排对账', async () => {
    submit.mockResolvedValue({
      taskId: 't1',
      config: { channel: 'google', model: 'nano-banana-pro', params: {} },
    });
    await processor.process(job);
    expect(mockMedia.markSubmitted).toHaveBeenCalledWith(
      'v1',
      't1',
      expect.anything(),
    );
    expect(mockMedia.scheduleReconcile).toHaveBeenCalledWith('v1', 1);
    expect(mockMedia.settleFailed).not.toHaveBeenCalled();
  });

  it('提交期间被停止 → 判 cancelled，不排对账', async () => {
    submit.mockImplementation(() => {
      aborts.abort('v1'); // stop 端点恰在提交的 HTTP 调用期间到达
      return Promise.resolve({
        taskId: 't1',
        config: { channel: 'google', model: 'nano-banana-pro', params: {} },
      });
    });
    await processor.process(job);
    expect(mockMedia.markSubmitted).toHaveBeenCalled();
    expect(mockMedia.scheduleReconcile).not.toHaveBeenCalled();
    expect(mockMedia.settleFailed).toHaveBeenCalledWith(
      'v1',
      'g1',
      'c1',
      'image',
      '用户已停止',
      'cancelled',
    );
  });
});

describe('MediaProcessor 参考图地址', () => {
  const target = {
    id: 'v2',
    prompt: 'p',
    model: 'nano-banana-pro',
    channel: 'google',
    params: {},
    referenceVersionIds: ['ref-1'],
    generation: { id: 'g2', conversationId: 'c1', type: 'image' },
  };
  const ref: {
    id: string;
    status: string;
    filePath: string;
    providerTaskId: string | null;
  } = {
    id: 'ref-1',
    status: 'done',
    filePath: 'ref-1.jpg',
    providerTaskId: 'task-ref',
  };
  const mockPrisma = {
    mediaVersion: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'v2' ? target : ref),
      ),
      update: jest.fn(),
    },
  };
  const mockMedia = {
    callbackUrl: jest.fn().mockResolvedValue(undefined),
    publicAssetUrl: jest.fn(),
    markSubmitted: jest.fn(),
    scheduleReconcile: jest.fn(),
    settleFailed: jest.fn(),
  };
  const mockAigc = {
    submit: jest.fn().mockResolvedValue({
      taskId: 't2',
      config: { channel: 'google', model: 'nano-banana-pro', params: {} },
    }),
    getTask: jest.fn().mockResolvedValue({
      task_id: 'task-ref',
      status: 'completed',
      output_data: { image_url: 'https://assets.example/ref-1.jpg' },
    }),
  };
  let processor: MediaProcessor;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StreamService, useValue: { publish: jest.fn() } },
        { provide: AigcService, useValue: mockAigc },
        { provide: MediaService, useValue: mockMedia },
        { provide: MEDIA_ABORTS, useValue: new AbortRegistry() },
      ],
    }).compile();
    processor = module.get(MediaProcessor);
  });

  afterEach(() => jest.clearAllMocks());

  const job = { name: 'generate', data: { versionId: 'v2' } } as Job<{
    versionId: string;
  }>;
  const submittedRefs = () =>
    (mockAigc.submit.mock.calls[0][0] as { references: unknown[] }).references;

  it('有公网基址：用我方签名地址，不查 aigc', async () => {
    mockMedia.publicAssetUrl.mockResolvedValue('https://tunnel/ref-1.jpg?t=x');
    await processor.process(job);
    expect(mockAigc.getTask).not.toHaveBeenCalled();
    expect(submittedRefs()).toEqual([
      { type: 'image', role: 'reference', url: 'https://tunnel/ref-1.jpg?t=x' },
    ]);
  });

  it('没有公网基址、参考图是 aigc 产物：改用 aigc 的产物地址提交', async () => {
    mockMedia.publicAssetUrl.mockResolvedValue(null);
    await processor.process(job);
    expect(mockAigc.getTask).toHaveBeenCalledWith('task-ref');
    expect(submittedRefs()).toEqual([
      {
        type: 'image',
        role: 'reference',
        url: 'https://assets.example/ref-1.jpg',
      },
    ]);
    expect(mockMedia.settleFailed).not.toHaveBeenCalled();
  });

  it('没有公网基址、参考图也不是 aigc 产物：判失败并说明原因，不提交', async () => {
    mockMedia.publicAssetUrl.mockResolvedValue(null);
    mockPrisma.mediaVersion.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'v2' ? target : { ...ref, providerTaskId: null },
        ),
    );
    await processor.process(job);
    expect(mockAigc.submit).not.toHaveBeenCalled();
    expect(mockMedia.settleFailed).toHaveBeenCalledWith(
      'v2',
      'g2',
      'c1',
      'image',
      expect.stringContaining('没有公网地址'),
      'failed',
    );
  });
});
