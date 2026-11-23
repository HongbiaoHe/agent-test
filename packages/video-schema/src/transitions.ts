/**
 * 视频轨转场：挂在片段上，表示「这一段 → 下一段」之间的转场（最后一段上的不生效）。
 *
 * 语义同 ffmpeg xfade（导出就用它）：前后两段在转场时长 d 内叠在一起播，成片总长减少 d；
 * 下一段在成片里的起点 = 这一段的终点 - d。音频轨与字幕按绝对时间放，不跟着移动。
 *
 * 内置 46 种 = 打包的 ffmpeg（开发用的 ffmpeg-static 6.0 与发布用的自建 9.0）都支持的 xfade 转场；
 * 另可写自定义表达式（type = custom，见 transition-expr.ts），预览把同一条表达式翻译成 WebGL。
 *
 * 实际生效的时长会被夹到 [0, 前后两段各自时长的一半]：保证一段同时有入场、出场转场时也不会被吃光。
 */
import { z } from 'zod';
import { validateExpr } from './transition-expr';

export const TRANSITION_TYPES = [
  'fade',
  'fadeblack',
  'fadewhite',
  'fadegrays',
  'fadefast',
  'fadeslow',
  'dissolve',
  'distance',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'wipetl',
  'wipetr',
  'wipebl',
  'wipebr',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'diagtl',
  'diagtr',
  'diagbl',
  'diagbr',
  'circleopen',
  'circleclose',
  'circlecrop',
  'rectcrop',
  'vertopen',
  'vertclose',
  'horzopen',
  'horzclose',
  'radial',
  'hlslice',
  'hrslice',
  'vuslice',
  'vdslice',
  'pixelize',
  'hblur',
  'zoomin',
  'squeezeh',
  'squeezev',
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** 选择面板的分组 */
export const TRANSITION_GROUPS = {
  fade: ['fade', 'fadeblack', 'fadewhite', 'fadegrays', 'fadefast', 'fadeslow', 'dissolve', 'distance'],
  wipe: ['wipeleft', 'wiperight', 'wipeup', 'wipedown', 'wipetl', 'wipetr', 'wipebl', 'wipebr'],
  slide: ['slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown'],
  shape: [
    'circleopen',
    'circleclose',
    'circlecrop',
    'rectcrop',
    'vertopen',
    'vertclose',
    'horzopen',
    'horzclose',
    'radial',
    'diagtl',
    'diagtr',
    'diagbl',
    'diagbr',
  ],
  effect: ['hlslice', 'hrslice', 'vuslice', 'vdslice', 'pixelize', 'hblur', 'zoomin', 'squeezeh', 'squeezev'],
} as const satisfies Record<string, readonly TransitionType[]>;
export type TransitionGroup = keyof typeof TRANSITION_GROUPS;

export const MIN_TRANSITION_SECONDS = 0.1;
export const MAX_TRANSITION_SECONDS = 5;
export const DEFAULT_TRANSITION_SECONDS = 0.5;

export const TransitionSchema = z
  .object({
    type: z.enum([...TRANSITION_TYPES, 'custom']),
    duration: z.number().min(MIN_TRANSITION_SECONDS).max(MAX_TRANSITION_SECONDS),
    /** type = custom：xfade 表达式（见 transition-expr.ts） */
    expr: z.string().max(2000).optional(),
    /** type = custom：给自创转场起的名字 */
    name: z.string().trim().min(1).max(60).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.type !== 'custom') return;
    const err = t.expr === undefined ? '自定义转场必须给 expr' : validateExpr(t.expr);
    if (err) ctx.addIssue({ code: 'custom', message: `转场表达式不合法：${err}`, path: ['expr'] });
  });
export type Transition = z.output<typeof TransitionSchema>;

export const isTransitionType = (v: unknown): v is TransitionType => TRANSITION_TYPES.some((t) => t === v);

/**
 * 每个接缝实际生效的转场时长（下标 i = 第 i 段 → 第 i+1 段，长度 = 片段数 - 1）。
 * durations 是各段在成片里本来的时长（视频 = 出点 - 入点，图片 = duration）。
 */
export function effectiveTransitions(
  transitions: ReadonlyArray<Transition | undefined>,
  durations: readonly number[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < durations.length - 1; i++) {
    const t = transitions[i];
    if (!t) {
      out.push(0);
      continue;
    }
    const d = Math.min(t.duration, durations[i] / 2, durations[i + 1] / 2);
    out.push(d >= 0.01 ? Math.round(d * 1000) / 1000 : 0);
  }
  return out;
}
