/**
 * 导出：把剪辑工程（时间线）翻译成一条 ffmpeg 命令并执行。
 *
 * 滤镜图（filter_complex）：
 * - 视频轨每段一路输入（视频用 -ss/-t 在输入端裁剪；图片用 -loop 1 按 duration 循环一帧）：
 *   等比缩放 + 补黑边到输出尺寸、setsar=1、统一 fps 与像素格式；
 *   每段配一路音频：有原声且音量 > 0 → 原声（调音量，apad + atrim 补齐到片段时长）；否则 anullsrc 静音，
 *   保证 concat 时每段音视频都在、时长对齐；
 * - concat 成主视频 + 主音轨；
 * - 音频轨每段：atrim 由输入端 -ss/-t 完成 → 音量 → 淡入淡出 → adelay 延到 start → 与主音轨 amix
 *   （normalize=0：不按路数压低音量；duration=first：以主音轨即视频轨长度为准）；
 * - 字幕：生成 ASS（3 种预设样式）后用 libass 的 subtitles 滤镜烧录；尺寸与断行和预览共用
 *   @agent-test/video-schema 的 subtitleLayout / wrapSubtitle（断行由剪辑器量宽后随导出请求传来）；
 * - 输出：H.264 + yuv420p + AAC，+faststart，-t 截到视频轨总长。
 */
import { spawn } from 'node:child_process';
import {
  clipDuration,
  projectDuration,
  SUBTITLE_FONT_FAMILY,
  SUBTITLE_FONT_HEIGHT_EM,
  subtitleLayout,
  type SubtitleStyle,
  type VideoProject,
} from '@agent-test/video-schema';

/** 混音统一的采样格式 */
const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

export interface ExportOptions {
  /** 工程里的工作区相对路径 → 本机绝对路径 */
  resolve: (src: string) => string;
  /** 视频片段的素材有没有音轨（ffprobe 读出；没有就补静音） */
  hasAudio: (src: string) => boolean;
  outputPath: string;
  /** null = 按画布原尺寸；否则按该高度等比缩放 */
  height: number | null;
  /** 字幕 ASS 文件路径；工程没有字幕时不用 */
  assPath: string | null;
}

/** 秒数保留 3 位小数，避免浮点长尾写进命令行 */
function sec(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** 输出尺寸：宽高都是偶数（yuv420p 要求）；指定高度时按画布比例缩放 */
export function outputSize(project: Pick<VideoProject, 'canvas'>, height: number | null): { width: number; height: number } {
  const { width, height: h } = project.canvas;
  if (height === null) return { width: even(width), height: even(h) };
  return { width: even((width * height) / h), height: even(height) };
}

/** 滤镜参数值转义：先转义选项值里的 \ ' :，再转义滤镜图层面的 \ ' [ ] , ; */
export function escapeFilterValue(v: string): string {
  return v.replace(/[\\':]/g, (c) => `\\${c}`).replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** 工程 → ffmpeg 参数（不含 ffmpeg 本身；进度输出参数由执行方追加） */
export function buildExportArgs(project: VideoProject, opts: ExportOptions): string[] {
  if (project.video.length === 0) throw new Error('empty timeline');
  const total = projectDuration(project);
  const { width: W, height: H } = outputSize(project, opts.height);
  const fps = project.canvas.fps;
  const inputs: string[] = [];
  const filters: string[] = [];
  let inputIndex = 0;

  const concatPads: string[] = [];
  project.video.forEach((clip, i) => {
    const dur = clipDuration(clip);
    const k = inputIndex++;
    if (clip.type === 'video') {
      inputs.push('-ss', sec(clip.inPoint), '-t', sec(dur), '-i', opts.resolve(clip.src));
    } else {
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(dur), '-i', opts.resolve(clip.src));
    }
    filters.push(
      `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,` +
        `trim=duration=${sec(dur)},setpts=PTS-STARTPTS[v${i}]`,
    );
    const useSource = clip.type === 'video' && clip.volume > 0 && opts.hasAudio(clip.src);
    filters.push(
      useSource
        ? `[${k}:a]${AUDIO_FORMAT},volume=${clip.volume},apad,atrim=duration=${sec(dur)},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${sec(dur)}[a${i}]`,
    );
    concatPads.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatPads.join('')}concat=n=${project.video.length}:v=1:a=1[vcat][acat]`);

  // 音频轨：音量为 0 或起点已在成片之外的段不参与
  const mixPads: string[] = [];
  project.audio.forEach((clip, j) => {
    if (clip.volume <= 0 || clip.start >= total) return;
    const dur = clip.outPoint - clip.inPoint;
    const k = inputIndex++;
    inputs.push('-ss', sec(clip.inPoint), '-t', sec(dur), '-i', opts.resolve(clip.src));
    const chain = [`[${k}:a]${AUDIO_FORMAT}`, `volume=${clip.volume}`];
    if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(clip.fadeIn)}`);
    if (clip.fadeOut > 0) chain.push(`afade=t=out:st=${sec(dur - clip.fadeOut)}:d=${sec(clip.fadeOut)}`);
    const delayMs = Math.round(clip.start * 1000);
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
    filters.push(`${chain.join(',')}[m${j}]`);
    mixPads.push(`[m${j}]`);
  });
  let audioOut = 'acat';
  if (mixPads.length) {
    filters.push(
      `[acat]${mixPads.join('')}amix=inputs=${mixPads.length + 1}:duration=first:dropout_transition=0:normalize=0[amix]`,
    );
    audioOut = 'amix';
  }

  let videoOut = 'vcat';
  if (opts.assPath && project.subtitles.cues.some((c) => c.start < total)) {
    filters.push(`[vcat]subtitles=filename=${escapeFilterValue(opts.assPath)}[vsub]`);
    videoOut = 'vsub';
  }

  return [
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoOut}]`,
    '-map',
    `[${audioOut}]`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    sec(total),
    '-movflags',
    '+faststart',
    opts.outputPath,
  ];
}

/** ASS 时间：h:mm:ss.cc */
function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

/** 字幕正文：换行 → \N；{ } \ 在 ASS 里是控制字符，换成全角形 */
function assText(text: string): string {
  return text
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r?\n/g, '\\N');
}

/**
 * 3 种预设样式 → ASS Style 行（颜色 &HAABBGGRR，AA=00 不透明）。
 * Fontsize 是字体 (winAscent + winDescent) 的像素高，= CSS 字号 × SUBTITLE_FONT_HEIGHT_EM（见 video-schema/subtitle.ts）。
 */
function assStyle(style: SubtitleStyle, size: { width: number; height: number }): string {
  const l = subtitleLayout(style, size);
  const fontSize = Math.round(l.fontSize * SUBTITLE_FONT_HEIGHT_EM);
  const margin = Math.round(l.margin);
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic,
  // Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const base = (border: number, outlineColour: string, backColour: string, out: number, align: number) =>
    `Style: Default,${SUBTITLE_FONT_FAMILY},${fontSize},&H00FFFFFF,&H00FFFFFF,${outlineColour},${backColour},0,0,0,0,100,100,0,0,` +
    `${border},${out},0,${align},${margin},${margin},${margin},1`;
  switch (style) {
    case 'bottom-box':
      // BorderStyle 3 = 不透明底框（libass 用 OutlineColour 画框）：半透明黑底，Outline 即内边距
      return base(3, '&H80000000', '&H80000000', Math.round(l.boxPadding), 2);
    case 'top':
      return base(1, '&H00000000', '&H00000000', Math.round(l.outline), 8);
    case 'bottom-outline':
      return base(1, '&H00000000', '&H00000000', Math.round(l.outline), 2);
  }
}

/**
 * 工程字幕 → ASS 文件内容（PlayRes = 输出尺寸；超出成片的字幕截掉）。
 * wrapped：字幕原文 → 剪辑器断好行的文本（行间 \n）；WrapStyle 2 关掉 libass 自动折行，只按这些行排。
 * 没给某条的断行时按原文输出（只有手动换行）。
 */
export function buildAss(
  project: VideoProject,
  size: { width: number; height: number },
  wrapped: Readonly<Record<string, string>> = {},
): string {
  const total = projectDuration(project);
  const events = project.subtitles.cues
    .filter((c) => c.start < total)
    .map(
      (c) => `Dialogue: 0,${assTime(c.start)},${assTime(Math.min(c.end, total))},Default,,0,0,0,,${assText(wrapped[c.text] ?? c.text)}`,
    );
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    assStyle(project.subtitles.style, size),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

export interface FfmpegRun {
  /** 结束：成功 resolve；失败 reject（message 含退出码与 stderr 末尾几行）；被 cancel 时 resolve('cancelled') */
  done: Promise<'done' | 'cancelled'>;
  cancel: () => void;
}

export class FfmpegError extends Error {
  constructor(
    readonly code: number | null,
    readonly detail: string,
  ) {
    super(`ffmpeg exited with code ${code}: ${detail}`);
  }
}

const STDERR_TAIL_LINES = 8;

/**
 * 跑 ffmpeg：-progress pipe:1 解析 out_time_us（老版本叫 out_time_ms，单位其实也是微秒），
 * 按总时长算 0～1 进度回调；stderr 只保留末尾几行用于报错。
 */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  totalSeconds: number,
  onProgress: (progress: number) => void,
): FfmpegRun {
  const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cancelled = false;
  let stdoutBuf = '';
  let stderrTail: string[] = [];
  let stderrBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
      if (m && totalSeconds > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / totalSeconds));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
    const lines = stderrBuf.split(/\r?\n|\r/);
    stderrBuf = lines.pop() ?? '';
    stderrTail = [...stderrTail, ...lines.filter((l) => l.trim())].slice(-STDERR_TAIL_LINES);
  });

  const done = new Promise<'done' | 'cancelled'>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (cancelled) return resolve('cancelled');
      if (code === 0) return resolve('done');
      const tail = [...stderrTail, stderrBuf].filter((l) => l.trim()).slice(-STDERR_TAIL_LINES);
      reject(new FfmpegError(code, tail.join('\n')));
    });
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      child.kill('SIGKILL');
    },
  };
}
