/**
 * 规则检查（纯计算、不碰文件）：剪辑器每次编辑后实时跑，check_video_project 也跑同一份。
 * 只抓对错明确的技术问题；要读素材内容的检查（黑场、静音、响度、人声被盖住）在 agent-host 用 ffmpeg 做。
 *
 * 每条问题带 code + 数值参数，不带文案：剪辑器按 i18n 显示，agent 侧用 describeLintIssue 出中文。
 */
import {
  clipDuration,
  layoutVideoTrack,
  projectDuration,
  type VideoProject,
} from './project';
import { subtitleLayout, wrapSubtitle } from './subtitle';

/** 阈值（改这里即可） */
export const LINT_THRESHOLDS = {
  /** 字幕断行后最多几行 */
  maxSubtitleLines: 2,
  /** 字幕每秒最多几个字（中文按字、其他文字按词） */
  maxCharsPerSecond: 6,
  /** 片段宽高比与画布差多少（相对值）算明显黑边 */
  aspectTolerance: 0.05,
  /** 素材短边低于画布短边的这个比例算放大发糊 */
  minResolutionRatio: 0.7,
  /** 片段短于这么多秒像闪了一下 */
  minClipSeconds: 0.4,
} as const;

export type LintCode =
  | 'subtitle_out_of_range'
  | 'subtitle_overlap'
  | 'subtitle_too_many_lines'
  | 'subtitle_too_fast'
  | 'letterbox'
  | 'low_resolution'
  | 'clip_too_short'
  | 'audio_out_of_range'
  | 'transition_clamped';

export type LintTargetKind = 'video' | 'audio' | 'subtitle';

export interface LintIssue {
  code: LintCode;
  target: { kind: LintTargetKind; id: string };
  /** 问题在成片时间轴上的区间（秒），剪辑器据此在时间线上标位置 */
  start: number;
  end: number;
  /** 实测值与阈值（含义随 code 而变，见 describeLintIssue） */
  value: number;
  limit: number;
}

const EPS = 1e-6;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 每个字之间都能断开的文字：与 subtitle.ts 断行的口径一致 */
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/u;

/**
 * 没有真实字体可量时的近似字宽（单位 em）：CJK / 全角 1em，空白 0.3em，其他 0.55em。
 * agent-host（Node 里没有 canvas）用它；剪辑器用字幕字体实测。
 */
export function approxMeasureEm(text: string): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? 1 : /\s/u.test(ch) ? 0.3 : 0.55;
  return w;
}

/** 阅读量：中文按字、其他文字按词 */
export function readingUnits(text: string): number {
  let n = 0;
  let inWord = false;
  for (const ch of text) {
    const letter = /[\p{L}\p{N}]/u.test(ch);
    if (CJK.test(ch)) {
      // 全角标点不算字
      if (letter) n++;
      inWord = false;
    } else if (letter) {
      if (!inWord) n++;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return n;
}

export interface LintOptions {
  /** 一段文字在 1em 字号下的宽（em）；不给用 approxMeasureEm */
  measureEm?: (text: string) => number;
}

export function lintProject(project: VideoProject, opts: LintOptions = {}): LintIssue[] {
  const measure = opts.measureEm ?? approxMeasureEm;
  const T = LINT_THRESHOLDS;
  const total = projectDuration(project);
  const { width: W, height: H } = project.canvas;
  const issues: LintIssue[] = [];

  // ── 视频轨 ──
  const canvasAspect = W / H;
  const laid = layoutVideoTrack(project);
  for (const { clip, start, end, transitionOut } of laid) {
    const target = { kind: 'video' as const, id: clip.id };
    // 转场被压短（前后片段太短）或挂在最后一段上（没有下一段，不生效）
    if (clip.transition && clip.transition.duration - transitionOut > 0.01) {
      issues.push({
        code: 'transition_clamped',
        target,
        start: end - Math.max(transitionOut, 0),
        end,
        value: transitionOut,
        limit: clip.transition.duration,
      });
    }
    const dur = clipDuration(clip);
    if (dur < T.minClipSeconds - EPS) {
      issues.push({ code: 'clip_too_short', target, start, end, value: round2(dur), limit: T.minClipSeconds });
    }
    const aspectDiff = Math.abs(clip.width / clip.height - canvasAspect) / canvasAspect;
    if (aspectDiff > T.aspectTolerance) {
      issues.push({ code: 'letterbox', target, start, end, value: round2(aspectDiff), limit: T.aspectTolerance });
    }
    const ratio = Math.min(clip.width, clip.height) / Math.min(W, H);
    if (ratio < T.minResolutionRatio) {
      issues.push({ code: 'low_resolution', target, start, end, value: round2(ratio), limit: T.minResolutionRatio });
    }
  }

  // ── 音频轨 ──
  for (const clip of project.audio) {
    const end = clip.start + (clip.outPoint - clip.inPoint);
    if (end > total + EPS) {
      issues.push({
        code: 'audio_out_of_range',
        target: { kind: 'audio', id: clip.id },
        start: clip.start,
        end,
        value: round2(end - Math.max(total, clip.start)),
        limit: round2(total),
      });
    }
  }

  // ── 字幕 ──
  const layout = subtitleLayout(project.subtitles.style, project.canvas);
  const maxWidthEm = layout.maxLineWidth / layout.fontSize;
  const cues = [...project.subtitles.cues].sort((a, b) => a.start - b.start);
  cues.forEach((cue, i) => {
    const target = { kind: 'subtitle' as const, id: cue.id };
    if (cue.end > total + EPS) {
      issues.push({
        code: 'subtitle_out_of_range',
        target,
        start: cue.start,
        end: cue.end,
        value: round2(cue.end - Math.max(total, cue.start)),
        limit: round2(total),
      });
    }
    const next = cues[i + 1];
    if (next && next.start < cue.end - EPS) {
      issues.push({
        code: 'subtitle_overlap',
        target,
        start: next.start,
        end: Math.min(cue.end, next.end),
        value: round2(Math.min(cue.end, next.end) - next.start),
        limit: 0,
      });
    }
    const lines = wrapSubtitle(cue.text, maxWidthEm, measure).length;
    if (lines > T.maxSubtitleLines) {
      issues.push({ code: 'subtitle_too_many_lines', target, start: cue.start, end: cue.end, value: lines, limit: T.maxSubtitleLines });
    }
    const cps = readingUnits(cue.text) / (cue.end - cue.start);
    if (cps > T.maxCharsPerSecond + EPS) {
      issues.push({ code: 'subtitle_too_fast', target, start: cue.start, end: cue.end, value: round2(cps), limit: T.maxCharsPerSecond });
    }
  });

  return issues.sort((a, b) => a.start - b.start);
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** 给 agent 看的中文说明 */
export function describeLintIssue(issue: LintIssue): string {
  const where = `${issue.target.kind === 'video' ? '视频片段' : issue.target.kind === 'audio' ? '音频片段' : '字幕'} ${issue.target.id}`;
  switch (issue.code) {
    case 'clip_too_short':
      return `${where} 只有 ${issue.value}s，短于 ${issue.limit}s，看起来像闪了一下`;
    case 'letterbox':
      return `${where} 的宽高比与画布差 ${pct(issue.value)}（超过 ${pct(issue.limit)}），导出会有明显黑边`;
    case 'low_resolution':
      return `${where} 的短边只有画布的 ${pct(issue.value)}（低于 ${pct(issue.limit)}），放大后会糊`;
    case 'audio_out_of_range':
      return `${where} 超出成片（${issue.limit}s）${issue.value}s，超出部分导出时被截掉`;
    case 'subtitle_out_of_range':
      return `${where} 超出成片（${issue.limit}s）${issue.value}s，超出部分导出时被截掉`;
    case 'subtitle_overlap':
      return `${where} 与下一条字幕重叠 ${issue.value}s`;
    case 'subtitle_too_many_lines':
      return `${where} 断行后有 ${issue.value} 行（最多 ${issue.limit} 行），请缩短或拆成两条`;
    case 'transition_clamped':
      return issue.value > 0
        ? `${where} 的转场设了 ${issue.limit}s，前后片段太短，实际只有 ${issue.value}s（最长为两段各自时长的一半）`
        : `${where} 的转场不生效（它是最后一段，或前后片段太短）`;
    case 'subtitle_too_fast':
      return `${where} 每秒 ${issue.value} 字（最多 ${issue.limit} 字），来不及读，请延长显示时间或精简文字`;
  }
}
