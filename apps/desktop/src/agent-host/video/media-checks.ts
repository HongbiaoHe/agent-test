/**
 * 要读素材内容的规则检查（ffmpeg 分析，耗时几秒）：check_video_project 每次都跑，结果并进 warnings。
 * - 黑场：视频片段截取区间里连续黑画面 ≥ 0.5 秒（blackdetect）；
 * - 静音：成片混音里连续 ≥ 2 秒没有声音（silencedetect，-50dB 以下算静音）；
 * - 响度：成片整体响度偏离 -14 LUFS ±2，或真峰值超过 -1 dBTP（ebur128）；
 * - 人声被盖住：配音（role=voice）播放期间，叠在上面的背景音乐（role=music）比它响。
 *   响度按「素材这段的积分响度 + 音量倍数换算的 dB」估，忽略淡入淡出。
 *
 * 纯计算的检查见 @agent-test/video-schema 的 lintProject。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipDuration, layoutVideoTrack, projectDuration, type VideoProject } from '@agent-test/video-schema';
import { buildAudioAnalysisArgs } from './export';

const run = promisify(execFile);

export const MEDIA_THRESHOLDS = {
  blackMinSeconds: 0.5,
  /** blackdetect 的像素阈值：亮度低于 10% 算黑 */
  blackPixel: 0.1,
  silenceMinSeconds: 2,
  silenceNoiseDb: -50,
  targetLufs: -14,
  lufsTolerance: 2,
  maxTruePeak: -1,
} as const;

/** 单次 ffmpeg 分析超时 */
const ANALYZE_TIMEOUT_MS = 90_000;

export type MediaCheckCode = 'black_frames' | 'silence' | 'loudness' | 'true_peak' | 'voice_masked';

export interface MediaIssue {
  code: MediaCheckCode;
  /** 指向某段素材；整条成片的问题（静音、响度）为 null */
  target: { kind: 'video' | 'audio'; id: string } | null;
  /** 成片时间轴上的区间（秒） */
  start: number;
  end: number;
  value: number;
  limit: number;
  /** voice_masked：被盖住的那段配音 */
  voiceId?: string;
}

export interface MediaCheckOptions {
  ffmpeg: string;
  /** 工程里的工作区相对路径 → 本机绝对路径 */
  resolve: (src: string) => string;
  hasAudio: (src: string) => boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sec = (n: number) => String(Math.round(n * 1000) / 1000);
const toDb = (volume: number) => 20 * Math.log10(volume);

/** 跑一次 ffmpeg，返回 stderr（分析滤镜的结果都打在 stderr 上） */
async function analyze(ffmpeg: string, args: string[]): Promise<string> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', ...args], {
    timeout: ANALYZE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stderr;
}

/** blackdetect 输出 → [[start, end]]（相对输入起点的秒数） */
export function parseBlackdetect(stderr: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of stderr.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

/** silencedetect 输出 → [[start, end]]；只有 start 没有 end 的（一直静到结尾）用 total 收尾 */
export function parseSilencedetect(stderr: string, total: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') open = t;
    else if (open !== null) {
      out.push([open, Math.min(t, total)]);
      open = null;
    }
  }
  if (open !== null && total - open > 0) out.push([open, total]);
  return out;
}

/** ebur128 汇总 → 积分响度（LUFS）与真峰值（dBFS）；静音时 ffmpeg 给 -70 LUFS / -inf */
export function parseEbur128(stderr: string): { integrated: number | null; truePeak: number | null } {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(summary);
  const p = /True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(summary);
  const num = (s: string | undefined) => (s === undefined ? null : s === '-inf' ? -Infinity : Number(s));
  return { integrated: num(i?.[1]), truePeak: num(p?.[1]) };
}

async function blackFrames(project: VideoProject, opts: MediaCheckOptions): Promise<MediaIssue[]> {
  const T = MEDIA_THRESHOLDS;
  const issues: MediaIssue[] = [];
  for (const { clip, start } of layoutVideoTrack(project)) {
    if (clip.type !== 'video') continue;
    const stderr = await analyze(opts.ffmpeg, [
      '-ss', sec(clip.inPoint), '-t', sec(clipDuration(clip)), '-i', opts.resolve(clip.src),
      '-vf', `blackdetect=d=${T.blackMinSeconds}:pix_th=${T.blackPixel}`, '-an', '-f', 'null', '-',
    ]);
    for (const [s, e] of parseBlackdetect(stderr)) {
      issues.push({
        code: 'black_frames',
        target: { kind: 'video', id: clip.id },
        start: round2(start + s),
        end: round2(start + e),
        value: round2(e - s),
        limit: T.blackMinSeconds,
      });
    }
  }
  return issues;
}

async function mixChecks(project: VideoProject, opts: MediaCheckOptions): Promise<MediaIssue[]> {
  const T = MEDIA_THRESHOLDS;
  const total = projectDuration(project);
  const stderr = await analyze(
    opts.ffmpeg,
    buildAudioAnalysisArgs(
      project,
      opts,
      `silencedetect=n=${T.silenceNoiseDb}dB:d=${T.silenceMinSeconds},ebur128=peak=true:framelog=verbose`,
    ),
  );
  const issues: MediaIssue[] = [];
  for (const [s, e] of parseSilencedetect(stderr, total)) {
    if (e - s < T.silenceMinSeconds - 1e-3) continue;
    issues.push({ code: 'silence', target: null, start: round2(s), end: round2(e), value: round2(e - s), limit: T.silenceMinSeconds });
  }
  const { integrated, truePeak } = parseEbur128(stderr);
  // 整条都静音时只报静音，不再报响度
  if (integrated !== null && Number.isFinite(integrated) && integrated > -70) {
    if (Math.abs(integrated - T.targetLufs) > T.lufsTolerance) {
      issues.push({ code: 'loudness', target: null, start: 0, end: round2(total), value: integrated, limit: T.targetLufs });
    }
  }
  if (truePeak !== null && truePeak > T.maxTruePeak) {
    issues.push({ code: 'true_peak', target: null, start: 0, end: round2(total), value: truePeak, limit: T.maxTruePeak });
  }
  return issues;
}

/** 一段素材（源文件时间 [from, from + dur)）的积分响度 */
async function segmentLoudness(opts: MediaCheckOptions, src: string, from: number, dur: number): Promise<number | null> {
  const stderr = await analyze(opts.ffmpeg, [
    '-ss', sec(from), '-t', sec(dur), '-i', opts.resolve(src), '-vn',
    '-af', 'ebur128=framelog=verbose', '-f', 'null', '-',
  ]);
  const { integrated } = parseEbur128(stderr);
  return integrated !== null && Number.isFinite(integrated) && integrated > -70 ? integrated : null;
}

async function voiceMasked(project: VideoProject, opts: MediaCheckOptions): Promise<MediaIssue[]> {
  const total = projectDuration(project);
  const audible = project.audio.filter((a) => a.volume > 0 && a.start < total);
  const voices = audible.filter((a) => a.role === 'voice');
  const music = audible.filter((a) => a.role === 'music');
  if (!voices.length || !music.length) return [];
  const issues: MediaIssue[] = [];
  for (const v of voices) {
    const vEnd = Math.min(total, v.start + v.outPoint - v.inPoint);
    const vLoud = await segmentLoudness(opts, v.src, v.inPoint, vEnd - v.start);
    if (vLoud === null) continue;
    const voiceLevel = vLoud + toDb(v.volume);
    for (const m of music) {
      const os = Math.max(v.start, m.start);
      const oe = Math.min(vEnd, m.start + m.outPoint - m.inPoint);
      if (oe - os < 0.5) continue;
      const mLoud = await segmentLoudness(opts, m.src, m.inPoint + (os - m.start), oe - os);
      if (mLoud === null) continue;
      const diff = mLoud + toDb(m.volume) - voiceLevel;
      if (diff > 0) {
        issues.push({
          code: 'voice_masked',
          target: { kind: 'audio', id: m.id },
          voiceId: v.id,
          start: round2(os),
          end: round2(oe),
          value: round2(diff),
          limit: 0,
        });
      }
    }
  }
  return issues;
}

export async function runMediaChecks(project: VideoProject, opts: MediaCheckOptions): Promise<MediaIssue[]> {
  if (project.video.length === 0) return [];
  const issues = [...(await blackFrames(project, opts)), ...(await mixChecks(project, opts)), ...(await voiceMasked(project, opts))];
  return issues.sort((a, b) => a.start - b.start);
}

/** 给 agent 看的中文说明 */
export function describeMediaIssue(issue: MediaIssue): string {
  const span = `${issue.start}s–${issue.end}s`;
  switch (issue.code) {
    case 'black_frames':
      return `视频片段 ${issue.target?.id ?? ''} 在 ${span} 有 ${issue.value}s 黑场（素材自带）`;
    case 'silence':
      return `成片 ${span} 连续 ${issue.value}s 没有声音（原声、音乐、配音都没有）`;
    case 'loudness':
      return `成片整体响度 ${issue.value} LUFS，偏离目标 ${issue.limit} LUFS 超过 ±${MEDIA_THRESHOLDS.lufsTolerance}，请整体调大 / 调小音量`;
    case 'true_peak':
      return `成片真峰值 ${issue.value} dBTP，超过 ${issue.limit} dBTP，可能破音，请调低最响那段的音量`;
    case 'voice_masked':
      return `配音 ${issue.voiceId ?? ''} 在 ${span} 被背景音乐 ${issue.target?.id ?? ''} 盖住（音乐比人声响 ${issue.value} dB），请调低这段音乐的音量`;
  }
}
