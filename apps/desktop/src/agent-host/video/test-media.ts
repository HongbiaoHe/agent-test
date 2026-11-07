/**
 * 单测用素材：用打包的 ffmpeg 现场生成（testsrc 画面 + sine 音频），不往仓库里放二进制文件。
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ffmpegBinaries } from './ffmpeg-paths';

const run = promisify(execFile);

async function ffmpeg(args: string[], out: string): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await run(ffmpegBinaries().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
}

/** 带音轨的视频（testsrc + 440Hz 正弦） */
export function makeVideo(out: string, opts: { seconds: number; width: number; height: number; audio: boolean }) {
  const size = `${opts.width}x${opts.height}`;
  const video = ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=30:duration=${opts.seconds}`];
  const audio = opts.audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${opts.seconds}`] : [];
  return ffmpeg([...video, ...audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(opts.audio ? ['-c:a', 'aac'] : []), '-shortest'], out);
}

export function makeAudio(out: string, seconds: number) {
  return ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac'], out);
}

export function makeImage(out: string, width: number, height: number) {
  return ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=1`, '-frames:v', '1'], out);
}

/** 在 root 下生成一套常用素材，返回工作区相对路径 */
export async function makeFixtures(root: string) {
  const files = {
    clipA: 'media/a.mp4',
    clipB: 'media/b.mp4',
    music: 'media/music.m4a',
    logo: 'media/logo.png',
  };
  await Promise.all([
    makeVideo(join(root, files.clipA), { seconds: 3, width: 320, height: 240, audio: true }),
    makeVideo(join(root, files.clipB), { seconds: 2, width: 640, height: 360, audio: false }),
    makeAudio(join(root, files.music), 5),
    makeImage(join(root, files.logo), 200, 100),
  ]);
  return files;
}
