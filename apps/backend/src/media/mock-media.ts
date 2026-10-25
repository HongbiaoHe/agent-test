import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ffmpegBin, ffmpegMessage } from './video-concat';

/**
 * 画布测试模式（Mock）：不调 aigc，本地渲染一张 / 一段占位素材顶替真实产物。
 *
 * 只替换「产物从哪来」这一段——版本、队列、上游等待、状态推送都走真实链路（见 MediaProcessor），
 * 所以拿它测的是真实的依赖关系，只是不花生成费用。占位画面上印着节点标题、模型、档位与引用的上游，
 * 画幅与时长按节点参数来，拼接后一眼看得出顺序与时长对不对。
 */

const run = promisify(execFile);

/** 能否使用测试模式：CANVAS_MOCK_MEDIA_ENABLED 显式开关；没配时开发环境默认开、生产默认关。 */
export function mockMediaEnabled(): boolean {
  const raw = process.env.CANVAS_MOCK_MEDIA_ENABLED?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

export type MockMediaType = 'image' | 'video';

/** 模拟耗时区间（毫秒）：视频明显慢于图片，「下游视频等上游图片」才会自然出现。 */
export const MOCK_DELAY_MS: Record<MockMediaType, [number, number]> = {
  image: [5_000, 10_000],
  video: [10_000, 20_000],
};

/** 在区间里随机取一个耗时（并行节点因此以不确定的先后完成）。 */
export function mockDelayMs(
  type: MockMediaType,
  rand: () => number = Math.random,
): number {
  const [min, max] = MOCK_DELAY_MS[type];
  return Math.round(min + (max - min) * rand());
}

/** 占位素材的长边像素：不跟清晰度档位走（档位只印在画面上），生成快、文件小、拼接快。 */
const LONG_SIDE: Record<MockMediaType, number> = { image: 1024, video: 720 };

/**
 * 占位素材尺寸：画幅严格按参数（`16:9` / `16x9`），`adaptive` 或认不出按 16:9。
 * 宽高都取偶数——libx264 + yuv420p 要求偶数边长。
 */
export function mockSize(
  type: MockMediaType,
  aspectRatio: string | undefined,
): { width: number; height: number } {
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/i.exec(
    aspectRatio ?? '',
  );
  const ratio = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 16 / 9;
  const long = LONG_SIDE[type];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1
    ? { width: long, height: even(long / ratio) }
    : { width: even(long * ratio), height: long };
}

/** 视频时长（秒）：取档位里的 duration，没有或不是正数（如 "-1" 自动）按 5 秒。 */
export function mockDuration(params: Record<string, string>): number {
  const n = Number(params.duration);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/** 画面上的文字：标题一行大字，其余每行一条信息。 */
export interface MockCard {
  title: string;
  lines: string[];
}

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 按宽度粗截一行（CJK 按 2 个字宽计），免得长提示词撑出画面。 */
function clip(text: string, width: number, fontSize: number): string {
  const budget = Math.floor((width - 48) / (fontSize * 0.55));
  let used = 0;
  let out = '';
  for (const ch of text) {
    used += /[⺀-￿]/.test(ch) ? 2 : 1;
    if (used > budget) return `${out}…`;
    out += ch;
  }
  return out;
}

/** 占位画面的 SVG：深色底 + 左下「MOCK」水印 + 标题与信息行。颜色是素材内容，不走界面 token。 */
export function mockSvg(
  card: MockCard,
  size: { width: number; height: number },
): string {
  const { width, height } = size;
  const base = Math.max(14, Math.round(Math.min(width, height) / 22));
  const title = Math.round(base * 1.6);
  const font =
    "PingFang SC, Hiragino Sans GB, 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
  const lines = card.lines
    .map(
      (l, i) =>
        `<text x="24" y="${48 + title + 16 + (i + 1) * base * 1.6}" font-size="${base}" fill="#c9c4bd">${escapeXml(clip(l, width, base))}</text>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${font}">` +
    `<rect width="100%" height="100%" fill="#1f1d1b"/>` +
    // 水印放左下：右下角留给画布卡片上的「Mock」角标，两者叠在一起会糊成一团
    `<text x="24" y="${height - 24}" font-size="${Math.round(base * 2.4)}" font-weight="700" fill="#f2b24c" fill-opacity="0.85">MOCK</text>` +
    `<text x="24" y="${48 + title}" font-size="${title}" font-weight="600" fill="#ffffff">${escapeXml(clip(card.title, width, title))}</text>` +
    lines +
    `</svg>`
  );
}

/** 渲染一张 PNG 占位图到 outPath。 */
export async function renderMockImage(
  outPath: string,
  card: MockCard,
  size: { width: number; height: number },
): Promise<void> {
  await sharp(Buffer.from(mockSvg(card, size)))
    .png()
    .toFile(outPath);
}

/**
 * 把一张占位图循环成指定时长的 MP4。withAudio=true 配一段很轻的提示音，
 * 否则不带音轨（与真实模型不出声时一致）。
 */
export async function renderMockVideo(
  outPath: string,
  framePath: string,
  durationSec: number,
  withAudio: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    '-y',
    '-loop',
    '1',
    '-framerate',
    '24',
    '-i',
    framePath,
    ...(withAudio
      ? ['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100']
      : []),
    '-t',
    String(durationSec),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    ...(withAudio ? ['-af', 'volume=0.08', '-c:a', 'aac', '-shortest'] : []),
    outPath,
  ];
  try {
    await run(ffmpegBin(), args, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(`占位视频渲染失败：${ffmpegMessage(e)}`);
  }
}

/** 可被停止打断的等待（模拟耗时期间用户点了停止，立刻收手）。 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('用户已停止'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('用户已停止'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
