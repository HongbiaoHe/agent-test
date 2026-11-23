import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyProject, projectDuration, type VideoProject } from '@agent-test/video-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAss, buildExportArgs, escapeFilterValue, type ExportOptions, outputSize, runFfmpeg } from './export';
import { ffmpegBinaries } from './ffmpeg-paths';
import { probeMedia } from './probe';
import { makeFixtures } from './test-media';

function project(): VideoProject {
  return {
    ...emptyProject('测试', { width: 1280, height: 720 }),
    video: [
      { id: 'v1', type: 'video', src: 'a.mp4', sourceDuration: 10, inPoint: 1, outPoint: 4, volume: 1, width: 1280, height: 720 },
      { id: 'v2', type: 'video', src: 'b.mp4', sourceDuration: 5, inPoint: 0, outPoint: 2, volume: 0.5, width: 640, height: 480 },
      { id: 'v3', type: 'image', src: 'logo.png', duration: 2, width: 200, height: 100 },
    ],
  };
}

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  resolve: (src) => `/ws/${src}`,
  hasAudio: (src) => src !== 'b.mp4',
  outputPath: '/ws/exports/out.mp4',
  height: null,
  assPath: null,
  ...over,
});

const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

describe('buildExportArgs', () => {
  it('视频片段按入出点在输入端裁剪；图片 -loop 1 按 duration；三段 concat', () => {
    const args = buildExportArgs(project(), opts());
    const joined = args.join(' ');
    expect(joined).toContain('-ss 1 -t 3 -i /ws/a.mp4');
    expect(joined).toContain('-ss 0 -t 2 -i /ws/b.mp4');
    expect(joined).toContain('-loop 1 -framerate 30 -t 2 -i /ws/logo.png');
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    const f = filterOf(args);
    expect(f).toContain('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vcat][acat]');
    // 等比缩放 + 补黑边到画布、setsar=1、统一 fps
    expect(f).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
    expect(f).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30');
  });

  it('有原声用原声（带音量）；没音轨的视频与图片片段补 anullsrc 静音，时长与片段一致', () => {
    const f = filterOf(buildExportArgs(project(), opts()));
    expect(f).toContain('[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1,apad,atrim=duration=3');
    expect(f).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2[a1]');
    expect(f).toContain('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2[a2]');
    expect(f).not.toContain('[1:a]');
  });

  it('原声音量为 0 也补静音，不引用原声', () => {
    const p = project();
    const first = p.video[0];
    if (first.type === 'video') p.video[0] = { ...first, volume: 0 };
    const f = filterOf(buildExportArgs(p, opts()));
    expect(f).not.toContain('[0:a]');
    expect(f).toContain('atrim=duration=3[a0]');
  });

  it('音频轨：裁剪、音量、淡入淡出、按 start 延后，与主音轨 amix 且不归一化；总长截到视频轨', () => {
    const p = project();
    p.audio = [
      { id: 'a1', src: 'music.mp3', role: 'music', sourceDuration: 60, start: 1.5, inPoint: 10, outPoint: 20, volume: 0.8, fadeIn: 1, fadeOut: 2 },
      { id: 'a2', src: 'vo.mp3', role: 'voice', sourceDuration: 5, start: 0, inPoint: 0, outPoint: 5, volume: 1, fadeIn: 0, fadeOut: 0 },
      // 起点在成片之后 / 音量为 0：不参与混音
      { id: 'a3', src: 'late.mp3', role: 'music', sourceDuration: 5, start: 100, inPoint: 0, outPoint: 5, volume: 1, fadeIn: 0, fadeOut: 0 },
      { id: 'a4', src: 'mute.mp3', role: 'music', sourceDuration: 5, start: 0, inPoint: 0, outPoint: 5, volume: 0, fadeIn: 0, fadeOut: 0 },
    ];
    const args = buildExportArgs(p, opts());
    const joined = args.join(' ');
    expect(joined).toContain('-ss 10 -t 10 -i /ws/music.mp3');
    expect(joined).not.toContain('late.mp3');
    expect(joined).not.toContain('mute.mp3');
    const f = filterOf(args);
    expect(f).toContain('[3:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.8,afade=t=in:st=0:d=1,afade=t=out:st=8:d=2,adelay=1500:all=1[m0]');
    expect(f).toContain('[4:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1[m1]');
    expect(f).toContain('[acat][m0][m1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[amix]');
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('[amix]');
    expect(args[args.indexOf('-t', args.indexOf('-filter_complex')) + 1]).toBe('7');
  });

  it('输出：H.264 + yuv420p + AAC + faststart，输出路径在最后', () => {
    const args = buildExportArgs(project(), opts());
    const joined = args.join(' ');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain('-c:a aac');
    expect(joined).toContain('-movflags +faststart');
    expect(args.at(-1)).toBe('/ws/exports/out.mp4');
    expect(joined).toContain('-map [vcat] -map [acat]');
  });

  it('字幕：有 assPath 且有字幕时用 subtitles 滤镜烧录（路径转义）', () => {
    const p = project();
    p.subtitles.cues = [{ id: 's1', start: 0, end: 1, text: 'hi' }];
    const args = buildExportArgs(p, opts({ assPath: "/tmp/a b/it's:x.ass" }));
    expect(filterOf(args)).toContain(`[vcat]subtitles=filename=${escapeFilterValue("/tmp/a b/it's:x.ass")}[vsub]`);
    expect(escapeFilterValue("/a'b:c")).toBe("/a\\\\\\'b\\\\:c");
    expect(args.join(' ')).toContain('-map [vsub]');
    // 没有字幕就算给了 assPath 也不烧
    expect(filterOf(buildExportArgs(project(), opts({ assPath: '/tmp/x.ass' })))).not.toContain('subtitles=');
  });

  it('指定高度：按画布比例缩放，宽高都是偶数', () => {
    const f = filterOf(buildExportArgs(project(), opts({ height: 720 })));
    expect(f).toContain('scale=1280:720:');
    const odd = { ...project(), canvas: { width: 1081, height: 1921, fps: 30 } };
    expect(outputSize(odd, null)).toEqual({ width: 1082, height: 1922 });
    expect(outputSize(odd, 720)).toEqual({ width: 406, height: 720 });
    expect(outputSize(project(), 1080)).toEqual({ width: 1920, height: 1080 });
    expect(filterOf(buildExportArgs(odd, opts({ height: 720 })))).toContain('scale=406:720:');
  });

  it('空时间线报错', () => {
    expect(() => buildExportArgs(emptyProject('x', { width: 10, height: 10 }), opts())).toThrow();
  });
});

describe('buildAss', () => {
  it('3 种预设：底部描边 / 底部半透明底框 / 顶部；时间格式 h:mm:ss.cc；超出成片的截掉；控制字符转义', () => {
    const p = project(); // 总长 7s
    p.subtitles.cues = [
      { id: 's1', start: 0.5, end: 2.25, text: '第一行\n第二行 {x}' },
      { id: 's2', start: 6, end: 9, text: '截到 7 秒' },
      { id: 's3', start: 8, end: 9, text: '在成片之后' },
    ];
    const ass = buildAss(p, { width: 1280, height: 720 });
    expect(ass).toContain('PlayResX: 1280');
    expect(ass).toContain('Dialogue: 0,0:00:00.50,0:00:02.25,Default,,0,0,0,,第一行\\N第二行 ｛x｝');
    expect(ass).toContain('Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,截到 7 秒');
    expect(ass).not.toContain('在成片之后');
    // 对齐：2 = 底部居中，8 = 顶部居中；BorderStyle 3 = 底框
    expect(ass).toMatch(/Style: Default,.*,1,3,0,2,/);
    p.subtitles.style = 'bottom-box';
    expect(buildAss(p, { width: 1280, height: 720 })).toMatch(/Style: Default,.*,&H80000000,&H80000000,.*,3,9,0,2,/);
    p.subtitles.style = 'top';
    expect(buildAss(p, { width: 1280, height: 720 })).toMatch(/,1,3,0,8,/);
  });

  it('字号按 CSS 字号 × 1.4 换算（与预览同大）；关掉 libass 自动折行，按剪辑器给的断行输出', () => {
    const p = project();
    p.subtitles.cues = [
      { id: 's1', start: 0, end: 2, text: '一二三四五六' },
      { id: 's2', start: 2, end: 4, text: '没给断行' },
    ];
    const ass = buildAss(p, { width: 1280, height: 720 }, { 一二三四五六: '一二三\n四五六' });
    // 720 高：CSS 字号 36 → ASS 50；边距 43
    expect(ass).toMatch(/Style: Default,PingFang SC,50,.*,2,43,43,43,1$/m);
    expect(ass).toContain('WrapStyle: 2');
    expect(ass).toContain(',,一二三\\N四五六');
    expect(ass).toContain(',,没给断行');
  });
});

describe('真实 ffmpeg 导出', () => {
  let ws: string;
  let files: Awaited<ReturnType<typeof makeFixtures>>;
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'spark-export-ws-'));
    files = await makeFixtures(ws);
  }, 60_000);
  afterAll(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('两段视频（一段无音轨、尺寸不同）+ 图片 + 背景音乐 + 字幕 → 时长 = 裁剪后总和，有音轨，分辨率正确', async () => {
    const { ffmpeg, ffprobe } = ffmpegBinaries();
    const p: VideoProject = {
      ...emptyProject('集成', { width: 320, height: 240 }),
      video: [
        { id: 'v1', type: 'video', src: files.clipA, sourceDuration: 3, inPoint: 0.5, outPoint: 2.5, volume: 1, width: 320, height: 240 },
        { id: 'v2', type: 'video', src: files.clipB, sourceDuration: 2, inPoint: 0, outPoint: 1.5, volume: 1, width: 640, height: 360 },
        { id: 'v3', type: 'image', src: files.logo, duration: 1, width: 200, height: 100 },
      ],
      audio: [{ id: 'a1', src: files.music, role: 'music', sourceDuration: 5, start: 0.5, inPoint: 0, outPoint: 5, volume: 0.5, fadeIn: 0.5, fadeOut: 0.5 }],
      subtitles: { style: 'bottom-box', cues: [{ id: 's1', start: 0, end: 2, text: '你好 Spark' }] },
    };
    const assPath = join(ws, 'sub.ass');
    await writeFile(assPath, buildAss(p, outputSize(p, null)));
    const out = join(ws, 'out.mp4');
    const hasAudio = new Map([
      [files.clipA, (await probeMedia(ffprobe, join(ws, files.clipA), files.clipA)).hasAudio],
      [files.clipB, (await probeMedia(ffprobe, join(ws, files.clipB), files.clipB)).hasAudio],
    ]);
    expect([...hasAudio.values()]).toEqual([true, false]);
    const args = buildExportArgs(p, {
      resolve: (src) => join(ws, src),
      hasAudio: (src) => hasAudio.get(src) ?? false,
      outputPath: out,
      height: null,
      assPath,
    });
    const progress: number[] = [];
    await expect(runFfmpeg(ffmpeg, args, 4.5, (x) => progress.push(x)).done).resolves.toBe('done');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((x) => x >= 0 && x <= 0.99)).toBe(true);

    const info = await probeMedia(ffprobe, out, 'out.mp4');
    expect(info).toMatchObject({ kind: 'video', width: 320, height: 240, hasAudio: true });
    expect(info.duration).toBeGreaterThan(4.5 - 0.15);
    expect(info.duration).toBeLessThan(4.5 + 0.15);
    expect((await readFile(out)).length).toBeGreaterThan(1000);
  }, 60_000);

  it('指定高度 → 输出按比例缩放；失败时带 stderr 末尾', async () => {
    const { ffmpeg, ffprobe } = ffmpegBinaries();
    const p: VideoProject = {
      ...emptyProject('缩放', { width: 640, height: 360 }),
      video: [{ id: 'v1', type: 'video', src: files.clipB, sourceDuration: 2, inPoint: 0, outPoint: 1, volume: 1, width: 640, height: 360 }],
    };
    const out = join(ws, 'small.mp4');
    const args = buildExportArgs(p, { resolve: (s) => join(ws, s), hasAudio: () => false, outputPath: out, height: 720, assPath: null });
    await runFfmpeg(ffmpeg, args, 1, () => undefined).done;
    expect(await probeMedia(ffprobe, out, 'small.mp4')).toMatchObject({ width: 1280, height: 720, hasAudio: true });

    const bad = buildExportArgs(p, { resolve: () => join(ws, 'nope.mp4'), hasAudio: () => false, outputPath: out, height: null, assPath: null });
    await expect(runFfmpeg(ffmpeg, bad, 1, () => undefined).done).rejects.toThrow(/nope\.mp4/);
  }, 60_000);
});

describe('转场导出（真跑 ffmpeg）', () => {
  let tws: string;
  const run = promisify(execFile);
  beforeAll(async () => {
    tws = await mkdtemp(join(tmpdir(), 'spark-export-transition-'));
    const { ffmpeg } = ffmpegBinaries();
    // 纯红 / 纯蓝两段（带正弦原声），方便按像素判断转场画面
    for (const [name, color, freq] of [['red', 'red', 440], ['blue', 'blue', 660]] as const) {
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=30:d=2`,
        '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=2`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-shortest', join(tws, `${name}.mp4`),
      ]);
    }
  }, 60_000);
  afterAll(async () => {
    await rm(tws, { recursive: true, force: true });
  });

  const twoClips = (transition: NonNullable<VideoProject['video'][number]['transition']>): VideoProject => ({
    ...emptyProject('转场', { width: 320, height: 240 }),
    video: [
      { id: 'r', type: 'video', src: 'red.mp4', sourceDuration: 2, inPoint: 0, outPoint: 2, volume: 1, width: 320, height: 240, transition },
      { id: 'b', type: 'video', src: 'blue.mp4', sourceDuration: 2, inPoint: 0, outPoint: 2, volume: 1, width: 320, height: 240 },
    ],
  });

  /** 导出后取 t 秒那一帧，返回 (x, y) 处的 RGB */
  async function exportAndSample(p: VideoProject, t: number, points: Array<[number, number]>) {
    const { ffmpeg, ffprobe } = ffmpegBinaries();
    const out = join(tws, `${p.video[0].transition?.type ?? 'x'}.mp4`);
    const args = buildExportArgs(p, { resolve: (s) => join(tws, s), hasAudio: () => true, outputPath: out, height: null, assPath: null });
    await runFfmpeg(ffmpeg, args, projectDuration(p), () => undefined).done;
    const info = await probeMedia(ffprobe, out, 'out.mp4');
    const { stdout } = await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const rgb = points.map(([x, y]) => {
      const o = (y * 320 + x) * 3;
      return [stdout[o], stdout[o + 1], stdout[o + 2]];
    });
    return { info, rgb };
  }

  const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
  const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;

  it('内置 wipeleft：成片 = 4 - 0.5 秒；转场正中左半是前一段、右半是后一段；有音轨', async () => {
    const p = twoClips({ type: 'wipeleft', duration: 0.5 });
    expect(projectDuration(p)).toBe(3.5);
    // 转场 [1.5, 2.0)，正中 1.75 秒：P = 0.5，x <= W*P 为前一段（红）
    const { info, rgb } = await exportAndSample(p, 1.75, [[40, 120], [280, 120]]);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(3.5 - 0.1);
    expect(info.duration).toBeLessThan(3.5 + 0.1);
    expect(isRed(rgb[0])).toBe(true);
    expect(isBlue(rgb[1])).toBe(true);
  }, 60_000);

  it('自定义表达式：上半前一段、下半后一段（与内置一样逐像素求值）', async () => {
    const p = twoClips({ type: 'custom', duration: 0.5, expr: 'if(lt(Y,H/2),A,B)', name: '上下分屏' });
    const { rgb } = await exportAndSample(p, 1.75, [[160, 40], [160, 200]]);
    expect(isRed(rgb[0])).toBe(true);
    expect(isBlue(rgb[1])).toBe(true);
  }, 60_000);
});
