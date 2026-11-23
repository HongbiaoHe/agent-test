import { z } from 'zod';
import { effectiveTransitions, TransitionSchema } from './transitions';

/**
 * desktop 视频剪辑工程（`<工作区>/videos/<名字>.sparkvideo.json`）。
 *
 * 固定三轨：
 * - 视频轨（video）：片段按数组顺序拼接；视频片段可裁入出点、调原声音量，
 *   图片片段按 duration 秒显示（片尾 Logo 等）；片段上的 transition 是它到下一段的转场，前后两段在转场时长内
 *   叠在一起播（成片变短，见 transitions.ts），没有转场时首尾相接；
 * - 音频轨（audio）：任意多段，各自有在成片里的起点 start，可重叠，导出时混音；每段标用途 role（配音 / 音乐 / 音效）；
 * - 字幕（subtitles）：一组带起止时间的文本，全局一套样式（预设）。
 * 画布取输出宽高；尺寸不同的片段等比缩放后补黑边。
 *
 * 素材 src 一律是**工作区相对路径**（不能是绝对路径、不能用 .. 跳出工作区）：
 * 工程与素材随工作区整体搬走仍可用，agent 也能用文件工具直接改。
 * 结构带 version，以后扩成多轨 / 转场时据此迁移。
 */

export const VIDEO_PROJECT_VERSION = 1;
export const PROJECT_FILE_SUFFIX = '.sparkvideo.json';
/** 工程文件默认目录（工作区相对） */
export const PROJECTS_DIR = 'videos';
/** 导出成片的目录（工作区相对） */
export const EXPORTS_DIR = 'exports';

/** 工作区相对路径：非空、不以 / 开头、不含 .. 段、不含反斜杠 */
export const WorkspacePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((seg) => seg === '..'),
    '必须是工作区内的相对路径（不能以 / 开头，不能含 ..）',
  );

const Id = z.string().min(1).max(64);
const Seconds = z.number().finite().nonnegative();
const Volume = z.number().min(0).max(2);
const Dimension = z.number().int().positive().max(8192);

export const VideoClipSchema = z
  .object({
    id: Id,
    type: z.literal('video'),
    src: WorkspacePathSchema,
    /** 素材本身的时长（秒，ffprobe 读出） */
    sourceDuration: z.number().finite().positive(),
    /** 截取区间 [inPoint, outPoint)，单位秒 */
    inPoint: Seconds,
    outPoint: z.number().finite().positive(),
    /** 原声音量，0 = 静音，1 = 原始 */
    volume: Volume.default(1),
    width: Dimension,
    height: Dimension,
    /** 来源：生成产物的 versionId（仅记录用，不参与渲染） */
    versionId: z.string().optional(),
    /** 到下一段的转场 */
    transition: TransitionSchema.optional(),
  })
  .refine((c) => c.outPoint > c.inPoint, { message: '出点必须大于入点', path: ['outPoint'] })
  .refine((c) => c.outPoint <= c.sourceDuration + 1e-6, {
    message: '出点不能超过素材时长',
    path: ['outPoint'],
  });

export const ImageClipSchema = z.object({
  id: Id,
  type: z.literal('image'),
  src: WorkspacePathSchema,
  /** 在成片里显示的秒数 */
  duration: z.number().finite().positive().max(600),
  width: Dimension,
  height: Dimension,
  versionId: z.string().optional(),
  /** 到下一段的转场 */
  transition: TransitionSchema.optional(),
});

export const TrackClipSchema = z.union([VideoClipSchema, ImageClipSchema]);

/**
 * 音频片段的用途：voice = 配音 / 人声，music = 背景音乐，sfx = 音效。
 * 只给检查规则用（如「人声被音乐盖住」），不影响混音；旧工程没有这个字段，按 music 处理。
 */
export const AUDIO_ROLES = ['voice', 'music', 'sfx'] as const;
export type AudioRole = (typeof AUDIO_ROLES)[number];

export const AudioClipSchema = z
  .object({
    id: Id,
    src: WorkspacePathSchema,
    role: z.enum(AUDIO_ROLES).default('music'),
    sourceDuration: z.number().finite().positive(),
    /** 在成片时间轴上的起点（秒） */
    start: Seconds,
    inPoint: Seconds,
    outPoint: z.number().finite().positive(),
    volume: Volume.default(1),
    fadeIn: Seconds.default(0),
    fadeOut: Seconds.default(0),
    versionId: z.string().optional(),
  })
  .refine((c) => c.outPoint > c.inPoint, { message: '出点必须大于入点', path: ['outPoint'] })
  .refine((c) => c.outPoint <= c.sourceDuration + 1e-6, {
    message: '出点不能超过素材时长',
    path: ['outPoint'],
  })
  .refine((c) => c.fadeIn + c.fadeOut <= c.outPoint - c.inPoint + 1e-6, {
    message: '淡入淡出总时长不能超过这段音频的时长',
    path: ['fadeOut'],
  });

export const SUBTITLE_STYLES = ['bottom-outline', 'bottom-box', 'top'] as const;
export type SubtitleStyle = (typeof SUBTITLE_STYLES)[number];

export const SubtitleCueSchema = z
  .object({
    id: Id,
    start: Seconds,
    end: z.number().finite().positive(),
    text: z.string().trim().min(1).max(500),
  })
  .refine((c) => c.end > c.start, { message: '字幕结束时间必须晚于开始时间', path: ['end'] });

export const CanvasSchema = z.object({
  width: Dimension,
  height: Dimension,
  fps: z.number().int().min(1).max(60).default(30),
});

export const VideoProjectSchema = z.object({
  version: z.literal(VIDEO_PROJECT_VERSION),
  name: z.string().trim().min(1).max(200),
  canvas: CanvasSchema,
  video: z.array(TrackClipSchema).max(500),
  audio: z.array(AudioClipSchema).max(200),
  subtitles: z.object({
    style: z.enum(SUBTITLE_STYLES).default('bottom-outline'),
    cues: z.array(SubtitleCueSchema).max(2000),
  }),
});

export type VideoClip = z.output<typeof VideoClipSchema>;
export type ImageClip = z.output<typeof ImageClipSchema>;
export type TrackClip = z.output<typeof TrackClipSchema>;
export type AudioClip = z.output<typeof AudioClipSchema>;
export type SubtitleCue = z.output<typeof SubtitleCueSchema>;
export type Canvas = z.output<typeof CanvasSchema>;
export type VideoProject = z.output<typeof VideoProjectSchema>;

export type ParseResult =
  | { ok: true; project: VideoProject }
  | { ok: false; issues: string[] };

/** 结构校验（zod）+ 语义校验（id 全局唯一）。issues 形如 `video.0.outPoint: 出点不能超过素材时长`。 */
export function parseProject(raw: unknown): ParseResult {
  const parsed = VideoProjectSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`),
    };
  }
  const project = parsed.data;
  const seen = new Set<string>();
  const issues: string[] = [];
  const ids = [
    ...project.video.map((c) => c.id),
    ...project.audio.map((c) => c.id),
    ...project.subtitles.cues.map((c) => c.id),
  ];
  for (const id of ids) {
    if (seen.has(id)) issues.push(`id 重复：${id}`);
    seen.add(id);
  }
  return issues.length ? { ok: false, issues } : { ok: true, project };
}

/** 视频轨上一段在成片里占的时长 */
export function clipDuration(clip: TrackClip): number {
  return clip.type === 'video' ? clip.outPoint - clip.inPoint : clip.duration;
}

export interface LaidOutClip {
  clip: TrackClip;
  index: number;
  /** 在成片里的起止时间（秒）；有转场时与相邻片段重叠 */
  start: number;
  end: number;
  /** 与上一段 / 下一段重叠的转场时长（实际生效的，见 effectiveTransitions）；没有为 0 */
  transitionIn: number;
  transitionOut: number;
}

/** 视频轨布局：按顺序拼接，有转场的接缝处下一段提前 d 秒开始（与上一段重叠） */
export function layoutVideoTrack(project: Pick<VideoProject, 'video'>): LaidOutClip[] {
  const durations = project.video.map(clipDuration);
  const overlaps = effectiveTransitions(
    project.video.map((c) => c.transition),
    durations,
  );
  let t = 0;
  return project.video.map((clip, index) => {
    const start = t;
    const end = start + durations[index];
    const transitionOut = overlaps[index] ?? 0;
    t = end - transitionOut;
    return { clip, index, start, end, transitionIn: overlaps[index - 1] ?? 0, transitionOut };
  });
}

/** 成片总时长 = 视频轨总时长（扣掉转场重叠；音频与字幕超出部分在导出时截掉） */
export function projectDuration(project: Pick<VideoProject, 'video'>): number {
  const laid = layoutVideoTrack(project);
  return laid.length ? laid[laid.length - 1].end : 0;
}

/** 新建空工程 */
export function emptyProject(name: string, canvas: { width: number; height: number; fps?: number }): VideoProject {
  return {
    version: VIDEO_PROJECT_VERSION,
    name,
    canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps ?? 30 },
    video: [],
    audio: [],
    subtitles: { style: 'bottom-outline', cues: [] },
  };
}
