/**
 * ffmpeg / ffprobe 二进制的位置。
 *
 * - 打包后：electron-builder 的 extraResources 把二进制拷进 `Contents/Resources/ffmpeg/`，main 经
 *   SPARK_FFMPEG_PATH / SPARK_FFPROBE_PATH 注入（同 SPARK_BUILTIN_SKILLS 的做法）；
 * - 开发时：main 优先用 `scripts/build-ffmpeg.sh` 自建在 `resources/ffmpeg/darwin-<arch>/` 的二进制，
 *   没有再回落到 `ffmpeg-static` / `ffprobe-static`（含 nonfree、不可分发，仅供开发 / 测试）；
 * - 单测（没有 main）：agent-host 自己按包解析兜底。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { hostI18n } from '../i18n';

export const FFMPEG_PATH_ENV = 'SPARK_FFMPEG_PATH';
export const FFPROBE_PATH_ENV = 'SPARK_FFPROBE_PATH';

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * 按 npm 包解析二进制路径（开发 / 单测用）；from = 用来解析包的基准文件（路径或 file:// URL）。
 * ffmpeg-static 导出字符串（平台不支持时为 null），ffprobe-static 导出 `{ path }`。
 */
export function packageBinaries(from: string): FfmpegBinaries | null {
  try {
    const req = createRequire(from);
    const ffmpeg = z.string().parse(req('ffmpeg-static'));
    const ffprobe = z.object({ path: z.string() }).parse(req('ffprobe-static')).path;
    return { ffmpeg, ffprobe };
  } catch {
    return null;
  }
}

/** scripts/build-ffmpeg.sh 的产物（目录名按 Node 的 process.arch：arm64 / x64）；没构建过返回 null */
export function localBuildBinaries(desktopDir: string): FfmpegBinaries | null {
  const dir = join(desktopDir, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`);
  const found = { ffmpeg: join(dir, 'ffmpeg'), ffprobe: join(dir, 'ffprobe') };
  return existsSync(found.ffmpeg) && existsSync(found.ffprobe) ? found : null;
}

let cached: FfmpegBinaries | null = null;

/** agent-host 侧取二进制路径：优先 main 注入的 env，没有再按包解析 */
export function ffmpegBinaries(): FfmpegBinaries {
  if (cached) return cached;
  const ffmpeg = process.env[FFMPEG_PATH_ENV];
  const ffprobe = process.env[FFPROBE_PATH_ENV];
  const found = ffmpeg && ffprobe ? { ffmpeg, ffprobe } : packageBinaries(import.meta.url);
  if (!found) throw new Error(hostI18n.t('errors.video.ffmpegMissing'));
  cached = found;
  return found;
}
