/**
 * 整片审片的共享约定：
 * - VideoReviewSchema：审片模型的结构化输出，也是 Web 后端 POST /media-api/video-reviews 的返回；
 * - ReviewFileSchema：desktop 把审片结果存成工程旁边的 `<名字>.review.json`，剪辑器据此在时间线上打标记；
 *   fingerprint 记下审片时工程的指纹，工程改过之后标记显示为「可能已过期」。
 */
import { z } from 'zod';
import { layoutVideoTrack, PROJECT_FILE_SUFFIX, type VideoProject } from './project';
import type { LintTargetKind } from './lint';

export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const;
export const REVIEW_CATEGORIES = [
  'pacing', // 节奏 / 镜头衔接
  'subtitle', // 字幕可读性、遮挡主体
  'subject', // 主体 / 产品是否持续在画面里
  'audio_sync', // 音画同步
  'voice_mismatch', // 配音与字幕不一致
  'hook', // 开头 3 秒抓不抓人
  'brief', // 与 brief 不符
  'other',
] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

// 注意：Gemini 的 responseJsonSchema 不认 exclusiveMinimum，数值下限一律 .min(0)
export const ReviewFindingSchema = z.object({
  start: z.number().min(0).describe('问题开始时间（秒，成片时间轴）'),
  end: z.number().min(0).describe('问题结束时间（秒）'),
  severity: z.enum(REVIEW_SEVERITIES),
  category: z.enum(REVIEW_CATEGORIES),
  problem: z.string().describe('问题是什么（一句话，具体到画面 / 声音）'),
  suggestion: z.string().describe('怎么改（可操作：换哪段、剪短多少、字幕挪到哪）'),
});

export const VideoReviewSchema = z.object({
  summary: z.string().describe('总体评价，一两句'),
  verdict: z.enum(['pass', 'needs_work']).describe('pass = 可以交付；needs_work = 还有要改的问题'),
  strengths: z.array(z.string()).describe('做得好的地方（最多 3 条）'),
  issues: z.array(ReviewFindingSchema).describe('问题列表，按时间先后'),
});

export type ReviewFinding = z.output<typeof ReviewFindingSchema>;
export type VideoReview = z.output<typeof VideoReviewSchema>;

export const REVIEW_FILE_SUFFIX = '.review.json';

/** `videos/promo.sparkvideo.json` → `videos/promo.review.json` */
export function reviewPathOf(projectPath: string): string {
  const base = projectPath.endsWith(PROJECT_FILE_SUFFIX)
    ? projectPath.slice(0, -PROJECT_FILE_SUFFIX.length)
    : projectPath.replace(/\.json$/, '');
  return `${base}${REVIEW_FILE_SUFFIX}`;
}

export const ReviewTargetSchema = z.object({
  kind: z.enum(['video', 'audio', 'subtitle']),
  id: z.string(),
});
export type ReviewTarget = { kind: LintTargetKind; id: string };

export const ReviewFileSchema = z.object({
  version: z.literal(1),
  reviewedAt: z.string(),
  /** 审片时工程的指纹（projectFingerprint） */
  fingerprint: z.string(),
  brief: z.string(),
  summary: z.string(),
  verdict: z.enum(['pass', 'needs_work']),
  strengths: z.array(z.string()),
  issues: z.array(ReviewFindingSchema.extend({ id: z.string(), targets: z.array(ReviewTargetSchema) })),
});
export type ReviewFile = z.output<typeof ReviewFileSchema>;
export type ReviewFileIssue = ReviewFile['issues'][number];

/** 键排好序的 JSON：同样内容不管对象键的先后，序列化结果一致 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 工程指纹（FNV-1a 32 位，十六进制）：只用来判断「审片之后工程改没改过」 */
export function projectFingerprint(project: VideoProject): string {
  const s = stableStringify(project);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 时间区间 [start, end] 覆盖到的片段与字幕（审片问题映射回 id，让 agent 知道改哪段） */
export function reviewTargets(project: VideoProject, start: number, end: number): ReviewTarget[] {
  // 模型给的是时间点（end ≤ start）时按 0.5 秒窗口算
  const s = start;
  const e = end > start ? end : start + 0.5;
  const hit = (a: number, b: number) => a < e && b > s;
  const out: ReviewTarget[] = [];
  for (const l of layoutVideoTrack(project)) if (hit(l.start, l.end)) out.push({ kind: 'video', id: l.clip.id });
  for (const c of project.subtitles.cues) if (hit(c.start, c.end)) out.push({ kind: 'subtitle', id: c.id });
  for (const a of project.audio) {
    if (hit(a.start, a.start + (a.outPoint - a.inPoint))) out.push({ kind: 'audio', id: a.id });
  }
  return out;
}

const t2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** 时间线概要（给审片模型对照用）：每个镜头 / 字幕 / 音频在成片里的起止时间 */
export function reviewOutline(project: VideoProject): string {
  const lines = [`画布 ${project.canvas.width}x${project.canvas.height}`, '视频轨（按顺序首尾相接）：'];
  for (const l of layoutVideoTrack(project)) {
    const tr = l.transitionOut > 0 && l.clip.transition ? `，接下一段用转场 ${l.clip.transition.name ?? l.clip.transition.type} ${t2(l.transitionOut)}s` : '';
    lines.push(`- ${l.clip.id} ${l.clip.type === 'image' ? '图片' : '视频'} ${t2(l.start)}s–${t2(l.end)}s${tr}`);
  }
  if (project.audio.length) {
    lines.push('音频轨：');
    for (const a of project.audio) {
      const role = a.role === 'voice' ? '配音' : a.role === 'sfx' ? '音效' : '音乐';
      lines.push(`- ${a.id} ${role} ${t2(a.start)}s–${t2(a.start + a.outPoint - a.inPoint)}s 音量 ${a.volume}`);
    }
  }
  if (project.subtitles.cues.length) {
    lines.push('字幕：');
    for (const c of project.subtitles.cues) lines.push(`- ${c.id} ${t2(c.start)}s–${t2(c.end)}s「${c.text}」`);
  }
  return lines.join('\n');
}
