/**
 * 时间线视频轨的预览帧：给一个视频素材按时间均匀抽帧，拼成一张横排的 JPEG 拼图（ffmpeg fps + scale + tile）。
 *
 * - 抽帧间隔：目标每 0.5 秒一帧，整条素材最多 MAX_FRAMES 帧（长素材间隔变大）；第 k 帧对应素材时间 k × interval
 *   （fps 滤镜取离该时刻最近的帧）；
 * - 每帧高 THUMB_HEIGHT（时间线上按 2 倍像素显示，够清楚），宽按素材宽高比取偶数；
 * - 结果按「绝对路径 + 大小 + 修改时间」缓存在应用数据目录（不放进工作区），素材改了自动重做；
 *   文件名前缀是路径的哈希，写新拼图时删掉同一路径的旧拼图（素材反复重生成也不会越积越多）；
 *   同一素材并发请求只跑一次 ffmpeg。
 * 拼图以 data URL 交给剪辑器：素材在工作区，拼图在应用数据目录，不经 spark-preview:// 协议。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { VideoThumbnails } from '../../shared/rpc';
import { probeMedia } from './probe';

export type { VideoThumbnails };

const run = promisify(execFile);

export const THUMB_HEIGHT = 72;
export const MAX_FRAMES = 120;
const TARGET_INTERVAL = 0.5;
/** 缓存格式变了就改这个，旧缓存自然作废 */
const CACHE_VERSION = 1;
const RENDER_TIMEOUT_MS = 120_000;


export function thumbnailPlan(
  duration: number,
  width: number,
  height: number,
): { count: number; interval: number; tileWidth: number; tileHeight: number } {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration / TARGET_INTERVAL)));
  const tileWidth = Math.max(2, Math.round((THUMB_HEIGHT * width) / height / 2) * 2);
  return { count, interval: duration / count, tileWidth, tileHeight: THUMB_HEIGHT };
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export class ThumbnailService {
  private readonly inflight = new Map<string, Promise<VideoThumbnails>>();

  constructor(private readonly deps: { cacheDir: string; ffmpeg: () => string; ffprobe: () => string }) {}

  /** abs：素材的本机绝对路径（调用方已校验在工作区内） */
  async get(abs: string): Promise<VideoThumbnails> {
    const st = await stat(abs);
    // 前缀 = 路径；后半 = 这一版内容（大小 + 修改时间 + 缓存格式）
    const key = `${sha1(abs)}-${sha1(`${CACHE_VERSION}\0${st.size}\0${st.mtimeMs}`)}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = this.load(abs, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  /** 素材被删了（删会话时它新建的视频移进废纸篓）：这个路径的拼图缓存一并删掉 */
  forget(abs: string): Promise<void> {
    return this.pruneOlder(`${sha1(abs)}-`);
  }

  /** 删掉同一路径（同前缀）的旧版本拼图；删不掉不影响本次结果 */
  private async pruneOlder(key: string): Promise<void> {
    const prefix = `${key.slice(0, key.indexOf('-'))}-`;
    const names = await readdir(this.deps.cacheDir).catch(() => []);
    for (const name of names) {
      if (name.startsWith(prefix) && name !== `${key}.jpg` && name !== `${key}.json`) {
        await rm(join(this.deps.cacheDir, name), { force: true }).catch(() => undefined);
      }
    }
  }

  private async load(abs: string, key: string): Promise<VideoThumbnails> {
    const jpg = join(this.deps.cacheDir, `${key}.jpg`);
    const meta = join(this.deps.cacheDir, `${key}.json`);
    const cached = await readCached(jpg, meta);
    if (cached) return cached;

    const info = await probeMedia(this.deps.ffprobe(), abs, abs);
    if (info.kind !== 'video' || info.duration === null || !info.width || !info.height) {
      throw new Error(`not a video: ${abs}`);
    }
    const plan = thumbnailPlan(info.duration, info.width, info.height);
    const { stdout } = await run(
      this.deps.ffmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        abs,
        '-an',
        '-vf',
        `fps=1/${plan.interval},scale=${plan.tileWidth}:${plan.tileHeight},tile=${plan.count}x1`,
        '-frames:v',
        '1',
        '-q:v',
        '5',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: RENDER_TIMEOUT_MS },
    );
    await mkdir(this.deps.cacheDir, { recursive: true });
    await writeFile(jpg, stdout);
    await writeFile(meta, JSON.stringify(plan));
    await this.pruneOlder(key);
    return { sprite: dataUrl(stdout), ...plan };
  }
}

const dataUrl = (jpg: Buffer) => `data:image/jpeg;base64,${jpg.toString('base64')}`;

const PlanSchema = z.object({
  count: z.number().int().positive(),
  interval: z.number().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
});

async function readCached(jpg: string, meta: string): Promise<VideoThumbnails | null> {
  try {
    const plan = PlanSchema.safeParse(JSON.parse(await readFile(meta, 'utf8')));
    return plan.success ? { sprite: dataUrl(await readFile(jpg)), ...plan.data } : null;
  } catch {
    return null;
  }
}
