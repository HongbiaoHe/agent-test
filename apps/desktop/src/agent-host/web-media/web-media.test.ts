import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userTextForModel } from '../run/attachments';
import { WebApi, WebApiError } from './web-api';
import { createSyncMediaTool, createWebMediaTools, uploadAttachment } from './web-media';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  body: Buffer;
}

let server: Server;
let base: string;
let seen: Seen[];
let dir: string;

const ok = (data: unknown) => ({ code: 0, message: 'ok', data });

/** 假 Web 后端：信封同 apps/backend ResponseInterceptor / AllExceptionsFilter */
function handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const url = req.url ?? '';
  // 假 CDN：公开地址，不带鉴权（同 aigc 产物的 CDN）
  if (url.startsWith('/cdn/')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from('PNGDATA'));
  }
  if (req.headers.authorization !== 'Bearer good-token') return send(401, { code: 401, message: 'Unauthorized' });
  if (url.startsWith('/media-api/models')) return send(200, ok({ models: [{ model: 'seedream-4.5' }] }));
  if (url === '/media-api/generations' && req.method === 'POST') {
    const input = JSON.parse(body.toString()) as { prompt: string; referenceVersionIds?: string[] };
    if (input.prompt === 'bad') {
      return send(200, ok({ ok: false, issues: [{ field: 'params.aspect_ratio', message: '不支持', value: '9:9' }] }));
    }
    if (input.referenceVersionIds?.includes('missing')) {
      return send(400, { code: 4005, message: '参考素材不存在或不属于本会话' });
    }
    return send(
      200,
      ok({
        ok: true,
        config: { model: 'seedream-4.5', channel: 'byteplus', params: { aspect_ratio: '1:1' } },
        generations: [{ generationId: 'g1', versionId: 'v1' }],
      }),
    );
  }
  if (url.startsWith('/media-api/uploads')) {
    return send(200, ok({ versionId: 'up1', type: 'image', url: `${base}/cdn/up1.png`, contentType: 'image/png', size: body.length }));
  }
  if (url === '/media-api/sources') {
    return send(
      200,
      ok({
        sources: [{ versionId: 'v1', type: 'image', filename: 'cat pic.png', url: `${base}/cdn/v1.png`, filePath: null }],
        errors: [{ versionId: 'nope', reason: '不是本会话的媒体' }],
      }),
    );
  }
  send(404, { code: 404, message: 'not found' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        body,
      });
      handle(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
beforeEach(async () => {
  seen = [];
  dir = await mkdtemp(join(tmpdir(), 'spark-webmedia-'));
  return () => rm(dir, { recursive: true, force: true });
});

describe('WebApi', () => {
  it('从 env 构造：缺地址或令牌 = 未登录', () => {
    expect(WebApi.fromEnv({})).toBeNull();
    expect(WebApi.fromEnv({ SPARK_WEB_API_URL: 'http://x/', SPARK_WEB_TOKEN: 't' })?.baseUrl).toBe('http://x');
  });

  it('剥信封；401 → 登录过期错误', async () => {
    expect(await new WebApi(base, 'good-token').get('/media-api/models?type=image')).toEqual({
      models: [{ model: 'seedream-4.5' }],
    });
    const err = await new WebApi(base, 'expired').get('/media-api/models?type=image').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebApiError);
    expect(err instanceof WebApiError && err.unauthorized).toBe(true);
  });
});

describe('媒体工具（与 Web 共用定义，经 /media-api 调 Web 的 MediaService）', () => {
  const tools = () => createWebMediaTools(new WebApi(base, 'good-token'), 'conv-1');

  it('五个工具名与 Web 一致', () => {
    expect(tools().map((t) => t.name)).toEqual([
      'list_media_models',
      'generate_image',
      'generate_video',
      'generate_audio',
      'clone_voice',
    ]);
  });

  it('generate_image：带上会话 scope 与类型，结果格式同 Web（status=queued + generations）', async () => {
    const [, image] = tools();
    const out: unknown = await image.invoke({ prompt: 'a cat', params: { aspect_ratio: '1:1' } });
    expect(JSON.parse(String(out))).toEqual({
      status: 'queued',
      model: 'seedream-4.5',
      channel: 'byteplus',
      params: { aspect_ratio: '1:1' },
      generations: [{ generationId: 'g1', versionId: 'v1' }],
    });
    const req = seen.find((s) => s.url === '/media-api/generations');
    expect(JSON.parse(req?.body.toString() ?? '{}')).toMatchObject({ scope: 'conv-1', type: 'image', prompt: 'a cat', count: 1 });
  });

  it('参数不合法回 issues；参考素材不存在回可改正的错误（同 Web 的 BusinessException 分支）', async () => {
    const [, image] = tools();
    const bad = JSON.parse(String(await image.invoke({ prompt: 'bad' }))) as { error: string; issues: unknown[] };
    expect(bad.error).toBe('invalid_params');
    expect(bad.issues).toHaveLength(1);
    const missing = JSON.parse(String(await image.invoke({ prompt: 'x', referenceVersionIds: ['missing'] }))) as {
      error: { code: number; message: string };
      hint: string;
    };
    expect(missing.error).toEqual({ code: 4005, message: '参考素材不存在或不属于本会话' });
    expect(missing.hint).toContain('versionId');
  });

  it('登录过期：把「重新登录」回给模型，而不是让整轮失败', async () => {
    const [, image] = createWebMediaTools(new WebApi(base, 'expired'), 'conv-1');
    const out = JSON.parse(String(await image.invoke({ prompt: 'x' }))) as { error: { code: string; message: string } };
    expect(out.error.code).toBe('unauthorized');
    expect(out.error.message).toContain('重新登录');
  });
});

describe('附件上传与同步进工作区', () => {
  it('图片附件流式上传（类型 / 大小正确），返回的 versionId 写进给模型的附件清单', async () => {
    const file = join(dir, 'cat.png');
    await writeFile(file, Buffer.from('0123456789'));
    const up = await uploadAttachment(new WebApi(base, 'good-token'), 'conv-1', file, 'cat.png');
    expect(up).toMatchObject({ versionId: 'up1', type: 'image' });
    const req = seen.find((s) => s.url.startsWith('/media-api/uploads'));
    expect(req?.url).toContain('scope=conv-1');
    expect(req?.contentType).toBe('image/png');
    expect(req?.contentLength).toBe('10');
    expect(req?.body.toString()).toBe('0123456789');
    const text = await userTextForModel({
      text: '用这张图',
      attachments: [{ filename: 'cat.png', path: file, size: 10, versionId: 'up1', mediaType: 'image' }],
    });
    expect(text).toContain('versionId=up1');
    // 不是图片 / 视频 / 音频：不上传
    expect(await uploadAttachment(new WebApi(base, 'good-token'), 'conv-1', file, 'notes.txt')).toBeNull();
  });

  it('sync_media_to_sandbox：从 CDN 下载到 <工作区>/media/<versionId>/，文件名清洗，错误一并返回', async () => {
    const t = createSyncMediaTool(new WebApi(base, 'good-token'), 'conv-1', dir);
    const out = JSON.parse(String(await t.invoke({ versionIds: ['v1', 'nope'] }))) as {
      synced: { path: string }[];
      errors: { versionId: string }[];
    };
    expect(out.synced[0].path).toBe(join(dir, 'media', 'v1', 'cat_pic.png'));
    expect(await readFile(out.synced[0].path, 'utf8')).toBe('PNGDATA');
    expect(out.errors.map((e) => e.versionId)).toEqual(['nope']);
  });
});
