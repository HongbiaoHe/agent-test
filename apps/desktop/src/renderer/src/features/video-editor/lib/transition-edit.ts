/**
 * 转场编辑（纯函数，单测见 transition-edit.test.ts）：给接缝设 / 换 / 去转场、应用到全部接缝、
 * 收集工程里已有的自定义转场（agent 自创的，在其他接缝上复用）、算时间线上接缝的位置。
 */
import {
  type LaidOutClip,
  layoutVideoTrack,
  type TrackClip,
  type Transition,
  type VideoProject,
} from '@agent-test/video-schema';

/** 去掉片段上的转场（返回新对象） */
export function withoutTransition<T extends TrackClip>(clip: T): T {
  const copy = { ...clip };
  delete copy.transition;
  return copy;
}

/** 给 clipId 那段（到下一段的接缝）设转场；null = 去掉 */
export function setTransition(project: VideoProject, clipId: string, transition: Transition | null): VideoProject {
  return {
    ...project,
    video: project.video.map((c) => (c.id !== clipId ? c : transition ? { ...c, transition } : withoutTransition(c))),
  };
}

/** 所有接缝（除最后一段外每段）都用同一个转场 */
export function applyTransitionToAll(project: VideoProject, transition: Transition): VideoProject {
  const last = project.video.length - 1;
  return { ...project, video: project.video.map((c, i) => (i < last ? { ...c, transition } : c)) };
}

/** 工程里出现过的自定义转场（按表达式去重，保留第一次出现的名字） */
export function customTransitionsOf(project: VideoProject): Transition[] {
  const seen = new Map<string, Transition>();
  for (const c of project.video) {
    const t = c.transition;
    if (t?.type === 'custom' && t.expr && !seen.has(t.expr)) seen.set(t.expr, t);
  }
  return [...seen.values()];
}

/** 素材路径的文件名（接缝说明用） */
export const fileName = (src: string): string => src.slice(src.lastIndexOf('/') + 1);

export interface Seam {
  from: LaidOutClip;
  to: LaidOutClip;
  /** 时间线上画接缝按钮的位置：有转场时在重叠区中点，没有时在交界处 */
  at: number;
}

export function seamsOf(project: VideoProject): Seam[] {
  const laid = layoutVideoTrack(project);
  return laid.slice(0, -1).map((from, i) => {
    const to = laid[i + 1];
    return { from, to, at: (to.start + from.end) / 2 };
  });
}
