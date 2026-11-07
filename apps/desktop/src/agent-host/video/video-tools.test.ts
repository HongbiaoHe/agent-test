import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject } from '@agent-test/video-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ffmpegBinaries } from './ffmpeg-paths';
import { makeFixtures } from './test-media';
import { checkVideoProjectTool, type CreateVideoProjectArgs, createVideoProjectTool } from './video-tools';

let ws: string;
let files: Awaited<ReturnType<typeof makeFixtures>>;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-video-tools-'));
  files = await makeFixtures(ws);
}, 60_000);
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

const createTool = () =>
  createVideoProjectTool({ conversationId: 'c1', workspaceDir: ws, webApi: null, ffprobe: () => ffmpegBinaries().ffprobe });

const json = (out: unknown) => z.record(z.string(), z.unknown()).parse(JSON.parse(String(out)));

async function create(args: CreateVideoProjectArgs): Promise<Record<string, unknown>> {
  return json(await createTool().invoke(args));
}

describe('create_video_project', () => {
  it('用工作区文件建工程：ffprobe 补全时长与尺寸，写出的文件能通过 parseProject，结果形状供卡片解析', async () => {
    const res = await create({
      name: 'Promo 片',
      clips: [{ path: files.clipA, inPoint: 0.5 }, { path: join(ws, files.clipB) }, { path: files.logo }],
      audio: [{ path: files.music, start: 1, volume: 0.6, fadeIn: 1, fadeOut: 1 }],
      subtitles: [{ start: 0, end: 2, text: '你好' }],
      subtitleStyle: 'top',
    });
    expect(res).toMatchObject({
      path: 'videos/promo-片.sparkvideo.json',
      name: 'Promo 片',
      duration: 7.5,
      videoClips: 3,
      audioClips: 1,
      subtitles: 1,
      warnings: [],
    });
    const parsed = parseProject(JSON.parse(await readFile(join(ws, 'videos/promo-片.sparkvideo.json'), 'utf8')));
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    const p = parsed.project;
    // 画布默认取第一段尺寸；绝对路径换成了工作区相对路径
    expect(p.canvas).toEqual({ width: 320, height: 240, fps: 30 });
    expect(p.video.map((c) => c.src)).toEqual([files.clipA, files.clipB, files.logo]);
    expect(p.video[0]).toMatchObject({ type: 'video', inPoint: 0.5, outPoint: 3, width: 320, height: 240 });
    expect(p.video[2]).toMatchObject({ type: 'image', duration: 3, width: 200, height: 100 });
    expect(p.audio[0]).toMatchObject({ start: 1, inPoint: 0, outPoint: 5, volume: 0.6 });
    expect(p.subtitles.style).toBe('top');
    expect(new Set([...p.video, ...p.audio, ...p.subtitles.cues].map((c) => c.id)).size).toBe(5);
  });

  it('同名文件已存在：加 -2、-3 后缀，不覆盖', async () => {
    const a = await create({ name: 'dup', clips: [{ path: files.clipB }] });
    const b = await create({ name: 'dup', clips: [{ path: files.clipB }] });
    const c = await create({ name: 'dup', clips: [{ path: files.clipB }], canvas: { width: 1080, height: 1920 } });
    expect([a.path, b.path, c.path]).toEqual([
      'videos/dup.sparkvideo.json',
      'videos/dup-2.sparkvideo.json',
      'videos/dup-3.sparkvideo.json',
    ]);
    expect(JSON.parse(await readFile(join(ws, 'videos/dup-3.sparkvideo.json'), 'utf8'))).toMatchObject({
      canvas: { width: 1080, height: 1920 },
    });
  });

  it('出点超过素材时长截断并给 warning；入点不小于出点报错', async () => {
    const ok = await create({ name: 'clamp', clips: [{ path: files.clipB, outPoint: 9 }] });
    expect(ok.duration).toBe(2);
    expect(ok.warnings).toEqual([expect.stringContaining('超过素材时长')]);
    const bad = await create({ name: 'bad', clips: [{ path: files.clipB, inPoint: 5 }] });
    expect(bad.error).toContain('入点必须小于出点');
  });

  it('versionId 在没登录 Web 账号时报错，提示登录或改用 path；路径出域 / 不存在 / 纯音频进视频轨都报错', async () => {
    expect((await create({ name: 'x', clips: [{ versionId: 'v-1' }] })).error).toContain('登录');
    expect((await create({ name: 'x', clips: [{ path: '../outside.mp4' }] })).error).toContain('不在工作区内');
    expect((await create({ name: 'x', clips: [{ path: 'media/none.mp4' }] })).error).toContain('不存在');
    expect((await create({ name: 'x', clips: [{ path: files.music }] })).error).toContain('不是视频或图片');
    expect((await create({ name: 'x', clips: [{ path: files.clipA, versionId: 'v' }] })).error).toContain('只能给 versionId 或 path 之一');
  });
});

describe('check_video_project', () => {
  it('报出缺失素材与总时长；格式坏了返回 issues', async () => {
    const res = await create({ name: 'check', clips: [{ path: files.clipA }, { path: files.clipB }] });
    const path = String(res.path);
    const check = checkVideoProjectTool({ workspaceDir: ws });
    const ok = json(await check.invoke({ path }));
    expect(ok).toEqual({ ok: true, issues: [], missing: [], duration: 5 });

    const raw = z
      .object({ video: z.array(z.object({ src: z.string() }).loose()) })
      .loose()
      .parse(JSON.parse(await readFile(join(ws, path), 'utf8')));
    raw.video[1].src = 'media/gone.mp4';
    await writeFile(join(ws, path), JSON.stringify(raw));
    expect(json(await check.invoke({ path }))).toEqual({
      ok: false,
      issues: [],
      missing: ['media/gone.mp4'],
      duration: 5,
    });

    await writeFile(join(ws, path), '{"version":1');
    const broken = z.object({ ok: z.boolean(), issues: z.array(z.string()) }).parse(json(await check.invoke({ path })));
    expect(broken.ok).toBe(false);
    expect(broken.issues[0]).toMatch(/^JSON/);
  });
});
