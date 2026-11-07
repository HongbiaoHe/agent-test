/**
 * 时间线上的直接编辑（纯函数，单测见 timeline-edit.test.ts）：拖拽移动 / 换位、拖边裁剪、吸附、
 * 在播放头处分割、复制，以及缩放（每秒像素）与刻度间隔。
 *
 * 拖拽按「按下那一刻的工程快照 + 累计位移」整体重算（不是逐帧累加），中途吸附 / 夹边不会累积误差；
 * 结果都经 lib/edit.ts 的夹值函数，保证落盘的工程总能通过 parseProject。
 */
import { type AudioClip, layoutVideoTrack, type SubtitleCue, type TrackClip, type VideoProject } from '@agent-test/video-schema';
import {
  clampImageDuration,
  MIN_SPAN,
  newId,
  retimeCue,
  round3,
  type Selection,
  trimAudioClip,
  trimVideoClip,
  updateAudioClip,
  updateCue,
  updateTrackClip,
} from './edit';
import { audioSpan } from './timeline';

export type ClipKind = NonNullable<Selection>['kind'];
/** move = 拖片段本体；start / end = 拖左边 / 右边裁剪 */
export type DragMode = 'move' | 'start' | 'end';

export interface DragTarget {
  kind: ClipKind;
  id: string;
  mode: DragMode;
}

// ---------- 缩放 ----------

/** 每秒像素的上下限 */
export const MIN_PPS = 0.5;
export const MAX_PPS = 400;
/** 放大 / 缩小一档的倍数 */
export const ZOOM_STEP = 1.5;
/** 吸附阈值（像素） */
export const SNAP_PX = 8;

export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));

/** 铺满可视宽度的每秒像素 */
export function fitPps(viewportWidth: number, span: number): number {
  return clampPps(viewportWidth > 0 && span > 0 ? viewportWidth / span : 50);
}

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** 刻度间隔：相邻刻度至少隔 minGapPx 像素的最小一档 */
export function tickStep(pps: number, minGapPx = 64): number {
  return TICK_STEPS.find((s) => s * pps >= minGapPx) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

// ---------- 片段的起止 ----------

export interface ClipSpan {
  start: number;
  end: number;
}

/** 某个片段在成片时间轴上的起止（找不到返回 null） */
export function spanOf(project: VideoProject, kind: ClipKind, id: string): ClipSpan | null {
  if (kind === 'video') {
    const l = layoutVideoTrack(project).find((x) => x.clip.id === id);
    return l ? { start: l.start, end: l.end } : null;
  }
  if (kind === 'audio') {
    const a = project.audio.find((c) => c.id === id);
    return a ? { start: a.start, end: a.start + audioSpan(a) } : null;
  }
  const c = project.subtitles.cues.find((x) => x.id === id);
  return c ? { start: c.start, end: c.end } : null;
}

/** 吸附目标：0、播放头、三条轨上其他片段的边（不含正在拖的那段自己），去重排序 */
export function snapTargets(project: VideoProject, exclude: { kind: ClipKind; id: string }, playhead: number): number[] {
  const out = new Set<number>([0, round3(playhead)]);
  const add = (kind: ClipKind, id: string, s: ClipSpan) => {
    if (kind === exclude.kind && id === exclude.id) return;
    out.add(round3(s.start));
    out.add(round3(s.end));
  };
  for (const l of layoutVideoTrack(project)) add('video', l.clip.id, l);
  for (const a of project.audio) add('audio', a.id, { start: a.start, end: a.start + audioSpan(a) });
  for (const c of project.subtitles.cues) add('cue', c.id, c);
  return [...out].sort((a, b) => a - b);
}

/**
 * 吸附：edges 是「按原始位移 delta 移动后」会落到的边的位置；找离任一目标最近（且在阈值内）的那条，
 * 把 delta 修正成让它正好对齐。返回修正后的 delta 与对齐到的时间点（没吸附则 null）。
 */
export function snapDelta(
  edges: readonly number[],
  delta: number,
  targets: readonly number[],
  threshold: number,
): { delta: number; snappedTo: number | null } {
  let best: { diff: number; target: number } | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const diff = target - edge;
      if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, target };
    }
  }
  return best ? { delta: delta + best.diff, snappedTo: best.target } : { delta, snappedTo: null };
}

// ---------- 拖拽 ----------

/** 视频轨换位：把 id 挪到 toIndex（按移走后的数组算），越界夹到两端 */
export function reorderTrackClip(project: VideoProject, id: string, toIndex: number): VideoProject {
  const from = project.video.findIndex((c) => c.id === id);
  if (from < 0) return project;
  const rest = project.video.filter((c) => c.id !== id);
  const to = Math.min(rest.length, Math.max(0, toIndex));
  if (to === from) return project;
  return { ...project, video: [...rest.slice(0, to), project.video[from], ...rest.slice(to)] };
}

/**
 * 拖视频轨片段时的落点：片段中心（按下时中心 + 位移）越过其他片段（按原布局）的中点就换位，
 * 中点在它左边的片段数即插入位置（按移走后的数组算）。
 */
export function reorderIndexAt(project: VideoProject, id: string, delta: number): number {
  const laid = layoutVideoTrack(project);
  const self = laid.find((l) => l.clip.id === id);
  if (!self) return -1;
  const center = (self.start + self.end) / 2 + delta;
  return laid.filter((l) => l.clip.id !== id && (l.start + l.end) / 2 < center).length;
}

export interface DragResult {
  project: VideoProject;
  /** 吸附到的时间点（画辅助线用），没吸附为 null */
  snappedTo: number | null;
}

/**
 * 按下时的工程 base + 累计位移 delta（秒）→ 拖拽后的工程。
 * - 视频轨 move：换位（不吸附）；start / end：裁入点 / 出点（图片改时长），后面的片段顺延（磁吸主轨）；
 * - 音频 move：改起点；start：起点与入点一起右移（右边界不动）；end：改出点；
 * - 字幕 move：整体平移（时长不变）；start / end：改开始 / 结束。
 * snap 给了就吸附（targets 由 snapTargets 算，threshold 为秒）。
 */
export function applyDrag(
  base: VideoProject,
  drag: DragTarget,
  rawDelta: number,
  snap: { targets: readonly number[]; threshold: number } | null,
): DragResult {
  const span = spanOf(base, drag.kind, drag.id);
  if (!span) return { project: base, snappedTo: null };

  if (drag.kind === 'video') {
    if (drag.mode === 'move') {
      return { project: reorderTrackClip(base, drag.id, reorderIndexAt(base, drag.id, rawDelta)), snappedTo: null };
    }
    // 磁吸主轨上拖左边：片段起点不动、内容变短，没有可对齐的边；拖右边：右边界 = end + delta
    const s = drag.mode === 'end' && snap ? snapDelta([span.end + rawDelta], rawDelta, snap.targets, snap.threshold) : { delta: rawDelta, snappedTo: null };
    const d = s.delta;
    const project = updateTrackClip(base, drag.id, (c) => trimTrackClip(c, drag.mode, d));
    return { project, snappedTo: s.snappedTo };
  }

  const edges = drag.mode === 'move' ? [span.start + rawDelta, span.end + rawDelta] : drag.mode === 'start' ? [span.start + rawDelta] : [span.end + rawDelta];
  const s = snap ? snapDelta(edges, rawDelta, snap.targets, snap.threshold) : { delta: rawDelta, snappedTo: null };
  const d = s.delta;

  if (drag.kind === 'audio') {
    return { project: updateAudioClip(base, drag.id, (c) => dragAudio(c, drag.mode, d)), snappedTo: s.snappedTo };
  }
  return { project: updateCue(base, drag.id, (c) => dragCue(c, drag.mode, d)), snappedTo: s.snappedTo };
}

function trimTrackClip(c: TrackClip, mode: DragMode, d: number): TrackClip {
  if (c.type === 'image') {
    return { ...c, duration: clampImageDuration(mode === 'start' ? c.duration - d : c.duration + d) };
  }
  // 拖哪边动哪边，对侧不动：先把位移夹到「至少留 MIN_SPAN」
  const min = Math.min(MIN_SPAN, c.sourceDuration);
  return mode === 'start'
    ? trimVideoClip(c, { inPoint: Math.min(c.inPoint + d, c.outPoint - min) })
    : trimVideoClip(c, { outPoint: Math.max(c.outPoint + d, c.inPoint + min) });
}

function dragAudio(c: AudioClip, mode: DragMode, d: number): AudioClip {
  if (mode === 'move') return { ...c, start: round3(Math.max(0, c.start + d)) };
  if (mode === 'end') return trimAudioClip(c, { outPoint: Math.max(c.outPoint + d, c.inPoint + Math.min(MIN_SPAN, c.sourceDuration)) });
  // 左边：起点和入点同步移动（素材在时间轴上的位置不变），受 入点 ≥ 0、起点 ≥ 0、至少留 MIN_SPAN 约束
  const lo = Math.max(-c.inPoint, -c.start);
  const hi = c.outPoint - c.inPoint - Math.min(MIN_SPAN, c.sourceDuration);
  const dd = Math.min(hi, Math.max(lo, d));
  const trimmed = trimAudioClip(c, { inPoint: c.inPoint + dd });
  return { ...trimmed, start: round3(c.start + dd) };
}

function dragCue(c: SubtitleCue, mode: DragMode, d: number): SubtitleCue {
  if (mode === 'move') {
    const dd = Math.max(-c.start, d);
    return { ...c, start: round3(c.start + dd), end: round3(c.end + dd) };
  }
  return mode === 'start'
    ? retimeCue(c, { start: Math.min(c.start + d, c.end - MIN_SPAN) })
    : retimeCue(c, { end: Math.max(c.end + d, c.start + MIN_SPAN) });
}

// ---------- 分割 / 复制 ----------

/**
 * 在成片时间 t 处把选中片段一分为二（两半各至少 MIN_SPAN，否则返回 null）。
 * 后半段用新 id 插在前半段之后；返回新工程与后半段的选中项。
 */
export function splitSelectionAt(
  project: VideoProject,
  sel: Selection,
  t: number,
  makeId: (prefix: string) => string = newId,
): { project: VideoProject; selection: Selection } | null {
  if (!sel) return null;
  const span = spanOf(project, sel.kind, sel.id);
  if (!span) return null;
  const local = t - span.start;
  if (local < MIN_SPAN - 1e-9 || span.end - t < MIN_SPAN - 1e-9) return null;

  if (sel.kind === 'video') {
    const i = project.video.findIndex((c) => c.id === sel.id);
    const c = project.video[i];
    const id = makeId('clip');
    let head: TrackClip;
    let tail: TrackClip;
    if (c.type === 'image') {
      head = { ...c, duration: round3(local) };
      tail = { ...c, id, duration: round3(c.duration - local) };
    } else {
      const cut = round3(c.inPoint + local);
      head = { ...c, outPoint: cut };
      tail = { ...c, id, inPoint: cut };
    }
    const video = [...project.video.slice(0, i), head, tail, ...project.video.slice(i + 1)];
    return { project: { ...project, video }, selection: { kind: 'video', id } };
  }

  if (sel.kind === 'audio') {
    const i = project.audio.findIndex((c) => c.id === sel.id);
    const c = project.audio[i];
    const id = makeId('audio');
    const cut = round3(c.inPoint + local);
    // 淡入留在前半、淡出留在后半，各自压进新时长
    const head = trimAudioClip({ ...c, outPoint: cut, fadeOut: 0 }, {});
    const tail = trimAudioClip({ ...c, id, start: round3(c.start + local), inPoint: cut, fadeIn: 0 }, {});
    const audio = [...project.audio.slice(0, i), head, tail, ...project.audio.slice(i + 1)];
    return { project: { ...project, audio }, selection: { kind: 'audio', id } };
  }

  const cues = project.subtitles.cues;
  const i = cues.findIndex((c) => c.id === sel.id);
  const c = cues[i];
  const id = makeId('cue');
  const cut = round3(t);
  const next = [...cues.slice(0, i), { ...c, end: cut }, { ...c, id, start: cut }, ...cues.slice(i + 1)];
  return { project: { ...project, subtitles: { ...project.subtitles, cues: next } }, selection: { kind: 'cue', id } };
}

/**
 * 复制选中片段：视频轨插在原片段之后（后面的顺延）；音频 / 字幕放在原片段结束处。返回新工程与副本的选中项。
 */
export function duplicateSelection(
  project: VideoProject,
  sel: Selection,
  makeId: (prefix: string) => string = newId,
): { project: VideoProject; selection: Selection } | null {
  if (!sel) return null;
  if (sel.kind === 'video') {
    const i = project.video.findIndex((c) => c.id === sel.id);
    if (i < 0) return null;
    const id = makeId('clip');
    const video = [...project.video.slice(0, i + 1), { ...project.video[i], id }, ...project.video.slice(i + 1)];
    return { project: { ...project, video }, selection: { kind: 'video', id } };
  }
  if (sel.kind === 'audio') {
    const i = project.audio.findIndex((c) => c.id === sel.id);
    if (i < 0) return null;
    const c = project.audio[i];
    const id = makeId('audio');
    const audio = [...project.audio.slice(0, i + 1), { ...c, id, start: round3(c.start + audioSpan(c)) }, ...project.audio.slice(i + 1)];
    return { project: { ...project, audio }, selection: { kind: 'audio', id } };
  }
  const cues = project.subtitles.cues;
  const i = cues.findIndex((c) => c.id === sel.id);
  if (i < 0) return null;
  const c = cues[i];
  const id = makeId('cue');
  const len = c.end - c.start;
  const copy: SubtitleCue = { ...c, id, start: round3(c.end), end: round3(c.end + len) };
  const next = [...cues, copy].sort((a, b) => a.start - b.start);
  return { project: { ...project, subtitles: { ...project.subtitles, cues: next } }, selection: { kind: 'cue', id } };
}
