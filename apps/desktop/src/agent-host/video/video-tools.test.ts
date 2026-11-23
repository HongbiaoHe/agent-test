import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject, TRANSITION_TYPES, validateExpr } from '@agent-test/video-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ffmpegBinaries } from './ffmpeg-paths';
import { makeFixtures } from './test-media';
import { checkVideoProjectTool, type CreateVideoProjectArgs, createVideoProjectTool, VIDEO_PROJECT_PROMPT } from './video-tools';

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
    // 画布取第一段 320x240（4:3），第二段 640x360（16:9）会有黑边
    expect(ok).toMatchObject({ ok: true, issues: [], missing: [], duration: 5 });
    const [warning, ...rest] = z
      .array(z.object({ code: z.string(), message: z.string(), start: z.number(), end: z.number() }))
      .parse(ok.warnings);
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ code: 'letterbox', start: 3, end: 5 });
    expect(warning.message).toMatch(/视频片段 v2 的宽高比/);

    const raw = z
      .object({ video: z.array(z.object({ src: z.string() }).loose()) })
      .loose()
      .parse(JSON.parse(await readFile(join(ws, path), 'utf8')));
    raw.video[1].src = 'media/gone.mp4';
    await writeFile(join(ws, path), JSON.stringify(raw));
    expect(json(await check.invoke({ path }))).toMatchObject({
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

  it('带 ffmpeg 时并入素材内容检查：没有原声的段报静音', async () => {
    const res = await create({ name: 'check-media', clips: [{ path: files.clipB }] });
    const check = checkVideoProjectTool({ workspaceDir: ws, binaries: ffmpegBinaries });
    const out = z
      .object({ ok: z.boolean(), warnings: z.array(z.object({ code: z.string(), message: z.string() })) })
      .parse(json(await check.invoke({ path: String(res.path) })));
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.code)).toContain('silence');
  }, 60_000);

  it('配音 role 写进工程', async () => {
    const res = await create({ name: 'role', clips: [{ path: files.clipA }], audio: [{ path: files.music, start: 0, role: 'voice' }] });
    const saved = parseProject(JSON.parse(await readFile(join(ws, String(res.path)), 'utf8')));
    expect(saved.ok && saved.project.audio[0].role).toBe('voice');
  });
});

describe('转场', () => {
  it('提示词列出全部内置转场；里面的自创示例都是合法表达式', () => {
    for (const type of TRANSITION_TYPES) expect(VIDEO_PROJECT_PROMPT).toContain(type);
    const examples = [...VIDEO_PROJECT_PROMPT.matchAll(/`((?:if|clip)\(.*?)`/g)].map((m) => m[1]);
    expect(examples).toHaveLength(3);
    for (const expr of examples) expect(validateExpr(expr)).toBeNull();
  });

  it('create_video_project：内置与自创转场写进工程，默认时长 0.5；表达式不合法时报错不落盘', async () => {
    const res = await create({
      name: '转场',
      clips: [
        { path: files.clipA, transition: { type: 'wipeleft' } },
        { path: files.logo, duration: 2, transition: { type: 'custom', duration: 0.4, name: '菱形', expr: 'if(lt(abs(X-W/2)/W+abs(Y-H/2)/H,1-P),B,A)' } },
        { path: files.clipB },
      ],
    });
    // 3 + 2 + 2 - 0.5 - 0.4
    expect(res.duration).toBe(6.1);
    const saved = parseProject(JSON.parse(await readFile(join(ws, String(res.path)), 'utf8')));
    expect(saved.ok && saved.project.video.map((c) => c.transition?.type ?? null)).toEqual(['wipeleft', 'custom', null]);
    expect(saved.ok && saved.project.video[0].transition?.duration).toBe(0.5);

    const bad = await create({ name: '坏转场', clips: [{ path: files.clipA, transition: { type: 'custom', expr: 'A<B' } }, { path: files.clipB }] });
    expect(String(bad.error)).toBe('工程校验不通过');
    expect(JSON.stringify(bad.issues)).toMatch(/转场表达式不合法/);
  });
});
