/**
 * 工程编辑（纯函数，返回新工程，不改入参）：检查器里的每个字段改动都经这里夹到 schema 允许的范围内，
 * 保证自动保存写回的工程总能通过 host 侧的 parseProject。
 */
import type { AudioClip, ImageClip, SubtitleCue, TrackClip, VideoClip, VideoProject } from '@agent-test/video-schema';
import type { VideoMediaProbe } from '../../../../../shared/rpc';

/** 片段最短保留的秒数（入点出点不能贴死） */
export const MIN_SPAN = 0.1;
/** 导入图片的默认显示秒数 */
export const DEFAULT_IMAGE_DURATION = 3;
/** 「在播放头处添加字幕」的默认时长 */
export const DEFAULT_CUE_DURATION = 2;
/** schema 的音量上限 */
export const MAX_VOLUME = 2;
/** schema 的图片时长上限 */
export const MAX_IMAGE_DURATION = 600;

/** 选中的对象（检查器显示它的字段） */
export type Selection =
  | { kind: 'video'; id: string }
  | { kind: 'audio'; id: string }
  | { kind: 'cue'; id: string }
  | null;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** 秒数保留三位小数，避免浮点尾巴写进 JSON */
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 视频片段的入点出点：0 ≤ in < out ≤ 素材时长，至少留 MIN_SPAN；改哪个就以哪个为准挤另一个 */
export function trimVideoClip(clip: VideoClip, patch: { inPoint?: number; outPoint?: number }): VideoClip {
  const span = Math.min(MIN_SPAN, clip.sourceDuration);
  let inPoint = clip.inPoint;
  let outPoint = clip.outPoint;
  if (patch.inPoint !== undefined) {
    inPoint = clamp(patch.inPoint, 0, clip.sourceDuration - span);
    outPoint = Math.max(outPoint, inPoint + span);
  }
  if (patch.outPoint !== undefined) {
    outPoint = clamp(patch.outPoint, span, clip.sourceDuration);
    inPoint = Math.min(inPoint, outPoint - span);
  }
  return { ...clip, inPoint: round3(inPoint), outPoint: round3(outPoint) };
}

/** 音频的入点出点与淡入淡出：同视频的裁剪规则，再把淡入淡出压进这段的时长里 */
export function trimAudioClip(
  clip: AudioClip,
  patch: { inPoint?: number; outPoint?: number; fadeIn?: number; fadeOut?: number },
): AudioClip {
  const span = Math.min(MIN_SPAN, clip.sourceDuration);
  let inPoint = clip.inPoint;
  let outPoint = clip.outPoint;
  if (patch.inPoint !== undefined) {
    inPoint = clamp(patch.inPoint, 0, clip.sourceDuration - span);
    outPoint = Math.max(outPoint, inPoint + span);
  }
  if (patch.outPoint !== undefined) {
    outPoint = clamp(patch.outPoint, span, clip.sourceDuration);
    inPoint = Math.min(inPoint, outPoint - span);
  }
  const length = outPoint - inPoint;
  let fadeIn = clamp(patch.fadeIn ?? clip.fadeIn, 0, length);
  let fadeOut = clamp(patch.fadeOut ?? clip.fadeOut, 0, length);
  if (fadeIn + fadeOut > length) {
    // 改的是哪个就保哪个，挤另一个；都没改（裁短了）就按比例缩
    if (patch.fadeOut !== undefined) fadeIn = length - fadeOut;
    else if (patch.fadeIn !== undefined) fadeOut = length - fadeIn;
    else {
      const k = length / (fadeIn + fadeOut);
      fadeIn *= k;
      fadeOut *= k;
    }
  }
  return {
    ...clip,
    inPoint: round3(inPoint),
    outPoint: round3(outPoint),
    // 向下取整：保证 round 之后 fadeIn + fadeOut 仍不超过时长
    fadeIn: Math.floor(fadeIn * 1000) / 1000,
    fadeOut: Math.floor(fadeOut * 1000) / 1000,
  };
}

/** 字幕起止：start ≥ 0，end > start（至少 MIN_SPAN） */
export function retimeCue(cue: SubtitleCue, patch: { start?: number; end?: number }): SubtitleCue {
  let start = cue.start;
  let end = cue.end;
  if (patch.start !== undefined) {
    start = Math.max(0, patch.start);
    end = Math.max(end, start + MIN_SPAN);
  }
  if (patch.end !== undefined) {
    end = Math.max(MIN_SPAN, patch.end);
    start = Math.min(start, end - MIN_SPAN);
  }
  return { ...cue, start: round3(start), end: round3(end) };
}

export const clampVolume = (v: number) => round3(clamp(v, 0, MAX_VOLUME));
export const clampImageDuration = (v: number) => round3(clamp(v, MIN_SPAN, MAX_IMAGE_DURATION));

export function updateTrackClip(project: VideoProject, id: string, fn: (c: TrackClip) => TrackClip): VideoProject {
  return { ...project, video: project.video.map((c) => (c.id === id ? fn(c) : c)) };
}

export function updateAudioClip(project: VideoProject, id: string, fn: (c: AudioClip) => AudioClip): VideoProject {
  return { ...project, audio: project.audio.map((c) => (c.id === id ? fn(c) : c)) };
}

export function updateCue(project: VideoProject, id: string, fn: (c: SubtitleCue) => SubtitleCue): VideoProject {
  return { ...project, subtitles: { ...project.subtitles, cues: project.subtitles.cues.map((c) => (c.id === id ? fn(c) : c)) } };
}

/** 视频轨片段左移（-1）/ 右移（+1）一位；到头不动 */
export function moveTrackClip(project: VideoProject, id: string, delta: -1 | 1): VideoProject {
  const i = project.video.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= project.video.length) return project;
  const video = [...project.video];
  [video[i], video[j]] = [video[j], video[i]];
  return { ...project, video };
}

export function removeSelection(project: VideoProject, sel: Selection): VideoProject {
  if (!sel) return project;
  if (sel.kind === 'video') return { ...project, video: project.video.filter((c) => c.id !== sel.id) };
  if (sel.kind === 'audio') return { ...project, audio: project.audio.filter((c) => c.id !== sel.id) };
  return { ...project, subtitles: { ...project.subtitles, cues: project.subtitles.cues.filter((c) => c.id !== sel.id) } };
}

/** 在 t 处加一条字幕（默认 2 秒），按开始时间插到合适位置，返回新工程与新字幕 id */
export function addCueAt(project: VideoProject, t: number, text: string, id = newId('cue')): { project: VideoProject; id: string } {
  const start = round3(Math.max(0, t));
  const cue: SubtitleCue = { id, start, end: round3(start + DEFAULT_CUE_DURATION), text };
  const cues = [...project.subtitles.cues, cue].sort((a, b) => a.start - b.start);
  return { project: { ...project, subtitles: { ...project.subtitles, cues } }, id };
}

/**
 * 这个探测结果能不能加进目标轨：视频 / 图片进视频轨；音频（及带音轨的视频，当背景音乐用）进音频轨；
 * 探测不出时长的视频 / 音频不能用。
 */
export function isImportable(p: VideoMediaProbe, target: 'visual' | 'audio'): boolean {
  const timed = p.duration !== null && p.duration > 0;
  if (target === 'visual') return p.kind === 'image' || (p.kind === 'video' && timed);
  return timed && (p.kind === 'audio' || (p.kind === 'video' && p.hasAudio));
}

/**
 * 把 video.importFiles 的探测结果组装成片段加进工程：视频 / 图片追加到视频轨末尾（缺尺寸的按画布尺寸），
 * 音频加到音频轨、起点 0。不能用的（见 isImportable）跳过，返回新工程与跳过的个数。
 */
export function addImportedMedia(
  project: VideoProject,
  probes: readonly VideoMediaProbe[],
  target: 'visual' | 'audio',
  makeId: (prefix: string) => string = newId,
): { project: VideoProject; skipped: number } {
  const video: TrackClip[] = [...project.video];
  const audio: AudioClip[] = [...project.audio];
  let skipped = 0;
  for (const p of probes) {
    if (!isImportable(p, target)) {
      skipped++;
      continue;
    }
    const width = p.width ?? project.canvas.width;
    const height = p.height ?? project.canvas.height;
    const duration = p.duration ?? 0;
    if (target === 'audio') {
      audio.push({
        id: makeId('audio'),
        src: p.path,
        sourceDuration: duration,
        start: 0,
        inPoint: 0,
        outPoint: duration,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
      });
    } else if (p.kind === 'image') {
      const clip: ImageClip = { id: makeId('clip'), type: 'image', src: p.path, duration: DEFAULT_IMAGE_DURATION, width, height };
      video.push(clip);
    } else {
      const clip: VideoClip = {
        id: makeId('clip'),
        type: 'video',
        src: p.path,
        sourceDuration: duration,
        inPoint: 0,
        outPoint: duration,
        volume: 1,
        width,
        height,
      };
      video.push(clip);
    }
  }
  return { project: { ...project, video, audio }, skipped };
}
