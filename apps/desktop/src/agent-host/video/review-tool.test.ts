import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFingerprint, ReviewFileSchema, type VideoReview } from '@agent-test/video-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { WebApi } from '../web-media/web-api';
import { ffmpegBinaries } from './ffmpeg-paths';
import { readProjectFile } from './project-files';
import { MAX_REVIEWS_PER_RUN, reviewVideoProjectTool } from './review-tool';
import { makeFixtures } from './test-media';
import { createVideoProjectTool } from './video-tools';

let ws: string;
let files: Awaited<ReturnType<typeof makeFixtures>>;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-review-tool-'));
  files = await makeFixtures(ws);
}, 60_000);
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

const REVIEW: VideoReview = {
  summary: '整体顺，片尾 logo 太突然',
  verdict: 'needs_work',
  strengths: ['开头有冲击力'],
  issues: [
    { start: 3.5, end: 4.5, severity: 'medium', category: 'pacing', problem: '跳到 logo 太突然', suggestion: '前一段多留 0.5 秒' },
    // 模型偶尔给出超出成片的时间：截到成片内
    { start: 9, end: 12, severity: 'low', category: 'other', problem: '结尾', suggestion: '无' },
  ],
};

/** 假 Web 接口：记下上传的文件大小与审片请求（cast-at-injection：只在注入处转成 WebApi） */
function fakeWeb() {
  const calls = { uploads: [] as Array<{ path: string; size: number; contentType: string }>, reviews: [] as unknown[] };
  const api = {
    upload: async (path: string, file: string, contentType: string) => {
      calls.uploads.push({ path, size: (await stat(file)).size, contentType });
      return { versionId: `ver${calls.uploads.length}`, type: 'video', url: 'https://cdn/x.mp4', contentType };
    },
    post: (path: string, body: object) => {
      calls.reviews.push({ path, body });
      return Promise.resolve(REVIEW);
    },
  };
  return { calls, api: api as unknown as WebApi };
}

const json = (out: unknown) => z.record(z.string(), z.unknown()).parse(JSON.parse(String(out)));

async function makeProject(name: string): Promise<string> {
  const create = createVideoProjectTool({ conversationId: 'c1', workspaceDir: ws, webApi: null, ffprobe: () => ffmpegBinaries().ffprobe });
  const res = json(
    await create.invoke({
      name,
      clips: [{ path: files.clipA }, { path: files.logo, duration: 2 }],
      audio: [{ path: files.music, start: 0, role: 'music' }],
      subtitles: [{ start: 0, end: 2, text: '新品上市' }],
    }),
  );
  return String(res.path);
}

describe('review_video_project', () => {
  it('没登录：返回 not_logged_in，不计次数', async () => {
    const path = await makeProject('未登录');
    const t = reviewVideoProjectTool({ conversationId: 'c1', workspaceDir: ws, webApi: null, binaries: ffmpegBinaries });
    for (let i = 0; i < MAX_REVIEWS_PER_RUN + 1; i++) {
      expect(json(await t.invoke({ path, brief: 'x' }))).toMatchObject({ error: 'not_logged_in' });
    }
  });

  it('渲染预览 → 上传 → 审片：意见映射回 id，写 review.json（带工程指纹），每轮最多 3 次', async () => {
    const path = await makeProject('审片');
    const { api, calls } = fakeWeb();
    const t = reviewVideoProjectTool({ conversationId: 'c1', workspaceDir: ws, webApi: api, binaries: ffmpegBinaries });

    const res = json(await t.invoke({ path, brief: '15 秒新品广告，投抖音' }));
    expect(res).toMatchObject({ verdict: 'needs_work', reviewFile: 'videos/审片.review.json', reviewsLeft: 2 });
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]).toMatchObject({ contentType: 'video/mp4' });
    expect(calls.uploads[0].path).toMatch(/^\/media-api\/uploads\?scope=c1&filename=review-preview\.mp4$/);
    expect(calls.uploads[0].size).toBeGreaterThan(1000);
    const sent = z
      .object({ path: z.string(), body: z.object({ versionId: z.string(), brief: z.string(), outline: z.string() }) })
      .parse(calls.reviews[0]);
    expect(sent.path).toBe('/media-api/video-reviews');
    expect(sent.body).toMatchObject({ versionId: 'ver1', brief: '15 秒新品广告，投抖音' });
    expect(sent.body.outline).toContain('v1 视频 0.00s–3.00s');

    const saved = ReviewFileSchema.parse(JSON.parse(await readFile(join(ws, 'videos/审片.review.json'), 'utf8')));
    const project = (await readProjectFile(ws, path)).project;
    expect(project && saved.fingerprint).toBe(project && projectFingerprint(project));
    expect(saved.issues[0]).toMatchObject({
      id: 'r1',
      start: 3.5,
      end: 4.5,
      targets: [
        { kind: 'video', id: 'v2' },
        { kind: 'audio', id: 'a1' },
      ],
    });
    // 成片 5 秒：超出的时间截到成片内
    expect(saved.issues[1]).toMatchObject({ start: 5, end: 5 });

    await t.invoke({ path, brief: 'x' });
    expect(json(await t.invoke({ path, brief: 'x' }))).toMatchObject({ reviewsLeft: 0 });
    expect(json(await t.invoke({ path, brief: 'x' }))).toMatchObject({ error: 'limit_reached' });
    expect(calls.reviews).toHaveLength(MAX_REVIEWS_PER_RUN);
  }, 120_000);

  it('素材缺失：先修好再审，不上传', async () => {
    const { api, calls } = fakeWeb();
    const t = reviewVideoProjectTool({ conversationId: 'c1', workspaceDir: ws, webApi: api, binaries: ffmpegBinaries });
    const res = json(await t.invoke({ path: 'videos/不存在.sparkvideo.json', brief: 'x' }));
    expect(String(res.error)).not.toBe('');
    expect(calls.uploads).toHaveLength(0);
  });
});
