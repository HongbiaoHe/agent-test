/**
 * 用 ffprobe 读素材信息：类型（视频 / 音频 / 图片）、时长、宽高、有无音轨。
 *
 * 判断口径：
 * - 常见图片扩展名直接当图片；否则看流——图片解码器（image2 / *_pipe 封装）的单帧视频流也当图片；
 * - 音频文件里的封面图（disposition.attached_pic）不算视频流；
 * - 手机竖拍视频带旋转元数据（rotate 标签 / Display Matrix）时宽高对调：ffmpeg 解码时会自动转正。
 */
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { VideoMediaProbe } from '../../shared/rpc';
import { hostI18n } from '../i18n';

const run = promisify(execFile);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif', '.heic']);
const PROBE_TIMEOUT_MS = 30_000;

const streamSchema = z
  .object({
    codec_type: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    disposition: z.object({ attached_pic: z.number().optional() }).loose().optional(),
    tags: z.object({ rotate: z.string().optional() }).loose().optional(),
    side_data_list: z.array(z.object({ rotation: z.number().optional() }).loose()).optional(),
  })
  .loose();

const probeSchema = z.object({
  streams: z.array(streamSchema).default([]),
  format: z
    .object({ format_name: z.string().optional(), duration: z.string().optional() })
    .loose()
    .optional(),
});

export type MediaInfo = Omit<VideoMediaProbe, 'path'>;

function rotation(s: z.infer<typeof streamSchema>): number {
  const fromTag = Number(s.tags?.rotate ?? 0);
  const fromSide = s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0;
  return Math.abs(fromTag || fromSide) % 180;
}

/** 读一个本机文件（绝对路径）的媒体信息；不是可识别的媒体抛错 */
export async function probeMedia(ffprobe: string, absPath: string, displayPath: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (e) {
    const detail = e instanceof Error && 'stderr' in e && typeof e.stderr === 'string' && e.stderr.trim();
    throw new Error(
      hostI18n.t('errors.video.probeFailed', {
        path: displayPath,
        error: detail || (e instanceof Error ? e.message : String(e)),
      }),
    );
  }
  const info = probeSchema.parse(JSON.parse(stdout));
  const video = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const hasAudio = info.streams.some((s) => s.codec_type === 'audio');
  const formatName = info.format?.format_name ?? '';
  const isImage =
    IMAGE_EXTS.has(extname(absPath).toLowerCase()) ||
    (!!video && !hasAudio && (formatName.startsWith('image2') || formatName.endsWith('_pipe')));
  const parsedDuration = Number(info.format?.duration);
  const duration = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : null;

  if (video?.width && video.height) {
    const swap = rotation(video) === 90;
    const width = swap ? video.height : video.width;
    const height = swap ? video.width : video.height;
    if (isImage) return { kind: 'image', duration: null, width, height, hasAudio: false };
    if (duration !== null) return { kind: 'video', duration, width, height, hasAudio };
  }
  if (hasAudio && duration !== null) return { kind: 'audio', duration, width: null, height: null, hasAudio: true };
  throw new Error(hostI18n.t('errors.video.notMedia', { path: displayPath }));
}
