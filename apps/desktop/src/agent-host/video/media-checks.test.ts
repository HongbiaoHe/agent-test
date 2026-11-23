import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { VIDEO_PROJECT_VERSION, type VideoProject } from '@agent-test/video-schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegBinaries } from './ffmpeg-paths';
import {
  describeMediaIssue,
  parseBlackdetect,
  parseEbur128,
  parseSilencedetect,
  runMediaChecks,
} from './media-checks';

const run = promisify(execFile);

async function ffmpeg(args: string[], out: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await run(ffmpegBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
}

let ws: string;
const files = {
  /** 3 秒画面，前 1 秒全黑；带 440Hz 原声 */
  blackStart: 'media/black-start.mp4',
  /** 3 秒画面，没有音轨 */
  mute: 'media/mute.mp4',
  /** 很轻的「配音」：4 秒 300Hz */
  voice: 'media/voice.m4a',
  /** 很响的「音乐」：4 秒 600Hz */
  music: 'media/music.m4a',
};

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'spark-media-checks-'));
  const abs = (p: string) => join(ws, p);
  await Promise.all([
    ffmpeg(
      [
        '-f', 'lavfi', '-i', "testsrc=size=320x240:rate=30:duration=3,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='lt(t,1)'",
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      ],
      abs(files.blackStart),
    ),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], abs(files.mute)),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=4,volume=0.05', '-c:a', 'aac'], abs(files.voice)),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000:duration=4,volume=0.8', '-c:a', 'aac'], abs(files.music)),
  ]);
}, 60_000);
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

const opts = (hasAudio: Record<string, boolean>) => ({
  ffmpeg: ffmpegBinaries().ffmpeg,
  resolve: (src: string) => join(ws, src),
  hasAudio: (src: string) => hasAudio[src] ?? false,
});

function project(patch: Partial<VideoProject>): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name: 't',
    canvas: { width: 320, height: 240, fps: 30 },
    video: [],
    audio: [],
    subtitles: { style: 'bottom-outline', cues: [] },
    ...patch,
  };
}

describe('解析 ffmpeg 分析输出', () => {
  it('blackdetect / silencedetect / ebur128', () => {
    expect(parseBlackdetect('[blackdetect @ 0x1] black_start:0 black_end:1.0333 black_duration:1.0333')).toEqual([[0, 1.0333]]);
    // 一直静到结尾：没有 silence_end，用总长收尾
    expect(parseSilencedetect('silence_start: 1.5\nsilence_end: 4 | silence_duration: 2.5\nsilence_start: 7', 10)).toEqual([
      [1.5, 4],
      [7, 10],
    ]);
    const summary = 'Summary:\n  Integrated loudness:\n    I:         -32.4 LUFS\n  True peak:\n    Peak:      -28.5 dBFS';
    expect(parseEbur128(summary)).toEqual({ integrated: -32.4, truePeak: -28.5 });
    expect(parseEbur128('Summary:\n    I:         -70.0 LUFS\n  True peak:\n    Peak:      -inf dBFS')).toEqual({
      integrated: -70,
      truePeak: -Infinity,
    });
  });
});

describe('runMediaChecks（真跑 ffmpeg）', () => {
  it('黑场映射到成片时间轴；没声音的段报静音', async () => {
    const p = project({
      video: [
        { id: 'v1', type: 'video', src: files.mute, sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240 },
        { id: 'v2', type: 'video', src: files.blackStart, sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240 },
      ],
    });
    const issues = await runMediaChecks(p, opts({ [files.blackStart]: true }));
    const black = issues.find((i) => i.code === 'black_frames');
    expect(black?.target).toEqual({ kind: 'video', id: 'v2' });
    // v2 在成片里从 3 秒开始，素材前 1 秒黑
    expect(black?.start).toBeCloseTo(3, 1);
    expect(black?.end).toBeCloseTo(4, 0);
    const silence = issues.find((i) => i.code === 'silence');
    expect(silence?.start).toBeCloseTo(0, 1);
    expect(silence?.end).toBeGreaterThanOrEqual(2.9);
    expect(describeMediaIssue(silence ?? issues[0])).toMatch(/没有声音/);
  }, 60_000);

  it('带转场的工程：混音分析用 acrossfade 能跑通，黑场仍按成片时间轴定位', async () => {
    const p = project({
      video: [
        { id: 'v1', type: 'video', src: files.mute, sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240, transition: { type: 'fade', duration: 1 } },
        { id: 'v2', type: 'video', src: files.blackStart, sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240 },
      ],
    });
    const issues = await runMediaChecks(p, opts({ [files.blackStart]: true }));
    // v2 从 2 秒开始（与 v1 重叠 1 秒），素材前 1 秒黑
    const black = issues.find((i) => i.code === 'black_frames');
    expect(black?.start).toBeCloseTo(2, 1);
    // v1 没有音轨：静音到 2 秒 v2 的原声交叉进来为止
    const silence = issues.find((i) => i.code === 'silence');
    expect(silence?.start).toBeCloseTo(0, 1);
    expect(silence?.end).toBeGreaterThanOrEqual(2);
    expect(silence?.end).toBeLessThan(2.3);
  }, 60_000);

  it('配音被音乐盖住；整体响度偏离目标', async () => {
    const p = project({
      video: [{ id: 'v1', type: 'video', src: files.mute, sourceDuration: 3, inPoint: 0, outPoint: 3, volume: 1, width: 320, height: 240 }],
      audio: [
        { id: 'vo', src: files.voice, role: 'voice', sourceDuration: 4, start: 0, inPoint: 0, outPoint: 3, volume: 1, fadeIn: 0, fadeOut: 0 },
        { id: 'bgm', src: files.music, role: 'music', sourceDuration: 4, start: 0, inPoint: 0, outPoint: 3, volume: 1, fadeIn: 0, fadeOut: 0 },
      ],
    });
    const issues = await runMediaChecks(p, opts({}));
    const masked = issues.find((i) => i.code === 'voice_masked');
    expect(masked).toMatchObject({ target: { kind: 'audio', id: 'bgm' }, voiceId: 'vo', start: 0, end: 3 });
    expect(masked?.value).toBeGreaterThan(20);
    expect(issues.some((i) => i.code === 'silence')).toBe(false);

    // 音乐调到很小：不再盖住人声
    p.audio[1] = { ...p.audio[1], volume: 0.01 };
    const after = await runMediaChecks(p, opts({}));
    expect(after.some((i) => i.code === 'voice_masked')).toBe(false);
    // 整体很轻：响度远低于 -14 LUFS
    const loud = after.find((i) => i.code === 'loudness');
    expect(loud?.value).toBeLessThan(-16);
  }, 60_000);
});
