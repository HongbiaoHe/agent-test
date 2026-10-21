import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import { AigcClient } from '../aigc/aigc.client';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { MediaUploadService } from './media-upload.service';

const mockPrisma = {
  conversation: { findFirst: jest.fn() },
  mediaGeneration: { create: jest.fn() },
};
const mockAigc = { requestUploadUrl: jest.fn() };

const signed = {
  upload_id: 'up-1',
  upload_url: 'https://storage.googleapis.com/bucket/x.png?sig=1',
  method: 'PUT',
  headers: {
    'Content-Type': 'image/png',
    'x-goog-content-length-range': '3,3',
  },
  expires_at: '2026-10-21T07:00:00.000Z',
  url: 'https://assets.example/x.png',
};

describe('MediaUploadService', () => {
  let service: MediaUploadService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        MediaUploadService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AigcClient, useValue: mockAigc },
      ],
    }).compile();
    service = module.get(MediaUploadService);
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    mockAigc.requestUploadUrl.mockResolvedValue(signed);
    mockPrisma.mediaGeneration.create.mockResolvedValue({
      id: 'gen-1',
      versions: [{ id: 'ver-1' }],
    });
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.clearAllMocks();
    fetchSpy.mockRestore();
  });

  const input = (
    over: Partial<Parameters<MediaUploadService['upload']>[0]>,
  ) => ({
    conversationId: 'conv-1',
    tenantId: 't1',
    userId: 'u1',
    contentType: 'image/png',
    size: 3,
    filename: 'x.png',
    body: Readable.from([Buffer.from([1, 2, 3])]),
    ...over,
  });

  it('类型不在白名单（gif）→ MEDIA_UPLOAD_UNSUPPORTED，不申请地址', async () => {
    await expect(
      service.upload(input({ contentType: 'image/gif' })),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_UPLOAD_UNSUPPORTED.code,
    });
    expect(mockAigc.requestUploadUrl).not.toHaveBeenCalled();
  });

  it('超过该类型上限（图片 > 20MB）→ MEDIA_UPLOAD_TOO_LARGE(413)', async () => {
    await expect(
      service.upload(input({ size: 20 * 1024 * 1024 + 1 })),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_UPLOAD_TOO_LARGE.code,
      status: 413,
    });
    // 同样字节数的视频在 200MB 以内，放行到会话校验
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    await expect(
      service.upload(
        input({ contentType: 'video/mp4', size: 20 * 1024 * 1024 + 1 }),
      ),
    ).rejects.toMatchObject({
      errCode: ErrorCodes.CONVERSATION_NOT_FOUND.code,
    });
  });

  it('缺 Content-Length（size 为 NaN）→ 拒绝', async () => {
    await expect(service.upload(input({ size: NaN }))).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_UPLOAD_UNSUPPORTED.code,
    });
  });

  it('成功：按签名 headers + Content-Length 流式 PUT，落 staged 版本', async () => {
    let sent = Buffer.alloc(0);
    fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
      // 把流式 body 读完，确认原样转发了文件字节
      const body = init.body;
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sent = Buffer.concat([sent, Buffer.from(value)]);
        }
      }
      return new Response('', { status: 200 });
    });

    const r = await service.upload(input({}));

    expect(mockAigc.requestUploadUrl).toHaveBeenCalledWith({
      contentType: 'image/png',
      size: 3,
      filename: 'x.png',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(signed.upload_url);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ ...signed.headers, 'Content-Length': '3' });
    expect([...sent]).toEqual([1, 2, 3]);

    expect(mockPrisma.mediaGeneration.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'conv-1',
        userId: 'u1',
        type: 'image',
        versions: {
          create: expect.objectContaining({
            prompt: 'x.png',
            model: 'upload',
            status: 'staged',
            url: signed.url,
            params: {
              contentType: 'image/png',
              size: '3',
              aigcUploadId: 'up-1',
            },
          }),
        },
      },
      include: { versions: true },
    });
    expect(r).toEqual({
      generationId: 'gen-1',
      versionId: 'ver-1',
      type: 'image',
      url: signed.url,
      filename: 'x.png',
      contentType: 'image/png',
      size: 3,
    });
  });

  it('GCS 拒收（403）→ MEDIA_UPLOAD_FAILED(502)，不落库', async () => {
    fetchSpy.mockResolvedValue(
      new Response('SignatureDoesNotMatch', { status: 403 }),
    );
    await expect(service.upload(input({}))).rejects.toMatchObject({
      errCode: ErrorCodes.MEDIA_UPLOAD_FAILED.code,
      status: 502,
    });
    expect(mockPrisma.mediaGeneration.create).not.toHaveBeenCalled();
  });
});
