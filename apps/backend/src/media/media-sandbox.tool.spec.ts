import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSyncMediaTool, type MediaSandbox } from './media-sandbox.tool';
import type { MediaService } from './media.service';

type Uploaded = Array<[string, Uint8Array]>;

describe('sync_media_to_sandbox', () => {
  const ctx = { conversationId: 'conv-1', userId: 'u1' };
  let uploaded: Uploaded;
  let sb: MediaSandbox;
  let fetchSpy: jest.SpyInstance;
  const resolveSandboxSources = jest.fn();
  const svc = { resolveSandboxSources } as unknown as MediaService;

  beforeEach(() => {
    uploaded = [];
    sb = {
      visibleRoot: '/workspace',
      uploadFiles: jest.fn((files: Uploaded) => {
        uploaded.push(...files);
        return Promise.resolve(files.map(([path]) => ({ path, error: null })));
      }),
    };
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([7, 8, 9])));
  });

  afterEach(() => {
    jest.clearAllMocks();
    fetchSpy.mockRestore();
  });

  const run = async (versionIds: string[]) => {
    const t = createSyncMediaTool(svc, sb, ctx);
    return JSON.parse(String(await t.invoke({ versionIds }))) as {
      synced: { versionId: string; type: string; path: string }[];
      errors?: { versionId: string; reason: string }[];
    };
  };

  it('CDN 资产：下载后写进 /workspace/media/<versionId>/<文件名>，文件名去掉空格等字符', async () => {
    resolveSandboxSources.mockResolvedValue({
      sources: [
        {
          versionId: 'v1',
          type: 'video',
          filename: 'my clip (1).mp4',
          url: 'https://cdn/x.mp4',
          filePath: null,
        },
      ],
      errors: [],
    });
    const r = await run(['v1', 'v1']);

    // 重复 id 去重后再解析
    expect(resolveSandboxSources).toHaveBeenCalledWith('conv-1', 'u1', ['v1']);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://cdn/x.mp4',
      expect.anything(),
    );
    expect(r).toEqual({
      synced: [
        {
          versionId: 'v1',
          type: 'video',
          path: '/workspace/media/v1/my_clip__1_.mp4',
        },
      ],
    });
    expect(uploaded.map(([p, b]) => [p, [...b]])).toEqual([
      ['/workspace/media/v1/my_clip__1_.mp4', [7, 8, 9]],
    ]);
  });

  it('只有本地文件的版本（拼接产物）：从 MEDIA_DATA_DIR 读出再写进沙箱', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-sync-'));
    const prev = process.env.MEDIA_DATA_DIR;
    process.env.MEDIA_DATA_DIR = dir;
    try {
      await writeFile(join(dir, 'v2.mp4'), Buffer.from([1, 2]));
      resolveSandboxSources.mockResolvedValue({
        sources: [
          {
            versionId: 'v2',
            type: 'video',
            filename: 'video.mp4',
            url: null,
            filePath: 'v2.mp4',
          },
        ],
        errors: [],
      });
      const r = await run(['v2']);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.synced[0].path).toBe('/workspace/media/v2/video.mp4');
      expect([...uploaded[0][1]]).toEqual([1, 2]);
    } finally {
      process.env.MEDIA_DATA_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('解析失败的、下载失败的单独报原因，不连累其余', async () => {
    resolveSandboxSources.mockResolvedValue({
      sources: [
        {
          versionId: 'ok',
          type: 'image',
          filename: 'a.png',
          url: 'https://cdn/a.png',
          filePath: null,
        },
        {
          versionId: 'gone',
          type: 'image',
          filename: 'b.png',
          url: 'https://cdn/b.png',
          filePath: null,
        },
      ],
      errors: [{ versionId: 'other', reason: '本会话没有这个媒体版本' }],
    });
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('b.png')
          ? new Response('', { status: 404 })
          : new Response(new Uint8Array([1])),
      ),
    );
    const r = await run(['ok', 'gone', 'other']);
    expect(r.synced.map((s) => s.versionId)).toEqual(['ok']);
    expect(r.errors).toEqual([
      { versionId: 'other', reason: '本会话没有这个媒体版本' },
      { versionId: 'gone', reason: '同步失败：下载资产失败 HTTP 404' },
    ]);
  });
});
