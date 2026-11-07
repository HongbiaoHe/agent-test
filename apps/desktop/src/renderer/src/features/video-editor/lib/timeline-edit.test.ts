import { layoutVideoTrack, parseProject } from '@agent-test/video-schema';
import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures';
import {
  applyDrag,
  duplicateSelection,
  fitPps,
  MAX_PPS,
  MIN_PPS,
  reorderIndexAt,
  reorderTrackClip,
  snapDelta,
  snapTargets,
  splitSelectionAt,
  tickStep,
} from './timeline-edit';

let n = 0;
const ids = (prefix: string) => `${prefix}-n${++n}`;
const valid = (p: unknown) => expect(parseProject(p)).toMatchObject({ ok: true });
const order = (p: ReturnType<typeof sampleProject>) => p.video.map((c) => c.id);

describe('缩放与刻度', () => {
  it('fitPps 铺满可视宽度并夹在上下限内', () => {
    expect(fitPps(900, 9)).toBe(100);
    expect(fitPps(100, 10_000)).toBe(MIN_PPS);
    expect(fitPps(10_000, 1)).toBe(MAX_PPS);
    expect(fitPps(0, 9)).toBe(50);
  });
  it('刻度间隔随缩放变化，相邻刻度至少 64px', () => {
    expect(tickStep(100)).toBe(1);
    expect(tickStep(10)).toBe(10);
    expect(tickStep(400)).toBe(0.25);
    expect(tickStep(1)).toBe(120);
  });
});

describe('吸附', () => {
  it('取最近且在阈值内的目标修正位移', () => {
    const a = snapDelta([4.95], 0.95, [0, 5, 9], 0.1);
    expect(a.snappedTo).toBe(5);
    expect(a.delta).toBeCloseTo(1);
    expect(snapDelta([4.5], 0.5, [0, 5], 0.1)).toEqual({ delta: 0.5, snappedTo: null });
    // 两条边都能吸：取差得最小的
    const r = snapDelta([2.04, 6.02], 0, [2, 6], 0.1);
    expect(r.snappedTo).toBe(6);
    expect(r.delta).toBeCloseTo(-0.02);
  });
  it('目标含 0、播放头和其他片段的边，不含自己', () => {
    const t = snapTargets(sampleProject(), { kind: 'audio', id: 'bgm' }, 2.5);
    expect(t).toEqual(expect.arrayContaining([0, 2.5, 4, 6, 9, 3, 8, 1.5, 5]));
    // bgm 自己的边 [1,5) 里 1 只来自它自己 → 不在目标里（5 来自字幕 c3）
    expect(t).not.toContain(1);
  });
});

describe('视频轨拖拽', () => {
  it('换位：中心越过相邻片段中点才换', () => {
    const p = sampleProject(); // a[0,4) img[4,6) b[6,9)，中点 2 / 5 / 7.5
    expect(reorderIndexAt(p, 'a', 0)).toBe(0);
    expect(reorderIndexAt(p, 'a', 2.9)).toBe(0); // 中心 4.9 未过 img 中点 5
    expect(reorderIndexAt(p, 'a', 3.5)).toBe(1);
    expect(reorderIndexAt(p, 'a', 6)).toBe(2);
    expect(reorderIndexAt(p, 'b', -3)).toBe(1); // 中心 4.5 过了 a 中点 2、未过 img 中点 5
    expect(order(applyDrag(p, { kind: 'video', id: 'b', mode: 'move' }, -10, null).project)).toEqual(['b', 'a', 'img']);
    expect(order(reorderTrackClip(p, 'a', 99))).toEqual(['img', 'b', 'a']);
    expect(reorderTrackClip(p, 'a', 0)).toBe(p);
  });

  it('拖右边改出点，后面的片段顺延；拖到素材尽头为止', () => {
    const p = sampleProject();
    const r = applyDrag(p, { kind: 'video', id: 'a', mode: 'end' }, 1, null).project;
    expect(r.video[0]).toMatchObject({ inPoint: 2, outPoint: 7 });
    expect(layoutVideoTrack(r)[1].start).toBe(5);
    const max = applyDrag(p, { kind: 'video', id: 'a', mode: 'end' }, 100, null).project;
    expect(max.video[0]).toMatchObject({ outPoint: 10 });
    valid(max);
  });

  it('拖左边改入点（不越过出点），图片拖边改时长', () => {
    const p = sampleProject();
    expect(applyDrag(p, { kind: 'video', id: 'a', mode: 'start' }, -5, null).project.video[0]).toMatchObject({ inPoint: 0, outPoint: 6 });
    expect(applyDrag(p, { kind: 'video', id: 'a', mode: 'start' }, 10, null).project.video[0]).toMatchObject({ inPoint: 5.9, outPoint: 6 });
    expect(applyDrag(p, { kind: 'video', id: 'img', mode: 'end' }, 1.5, null).project.video[1]).toMatchObject({ duration: 3.5 });
    expect(applyDrag(p, { kind: 'video', id: 'img', mode: 'start' }, 5, null).project.video[1]).toMatchObject({ duration: 0.1 });
  });

  it('拖右边吸附到播放头', () => {
    const p = sampleProject();
    const targets = snapTargets(p, { kind: 'video', id: 'a' }, 4.5);
    const r = applyDrag(p, { kind: 'video', id: 'a', mode: 'end' }, 0.46, { targets, threshold: 0.1 });
    expect(r.snappedTo).toBe(4.5);
    expect(r.project.video[0]).toMatchObject({ outPoint: 6.5 });
  });
});

describe('音频与字幕拖拽', () => {
  it('音频整体移动改起点，不小于 0，可吸附', () => {
    const p = sampleProject();
    expect(applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'move' }, 2, null).project.audio[0]).toMatchObject({ start: 3, inPoint: 10 });
    expect(applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'move' }, -5, null).project.audio[0].start).toBe(0);
    const targets = snapTargets(p, { kind: 'audio', id: 'bgm' }, 0);
    // 终点 5 + 0.95 → 吸到 6（img 结束）
    const r = applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'move' }, 0.95, { targets, threshold: 0.1 });
    expect(r.snappedTo).toBe(6);
    expect(r.project.audio[0].start).toBe(2);
  });

  it('音频拖左边：起点和入点同步右移，右边界不动；受入点 ≥ 0、起点 ≥ 0 约束', () => {
    const p = sampleProject();
    const r = applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'start' }, 1, null).project.audio[0];
    expect(r).toMatchObject({ start: 2, inPoint: 11, outPoint: 14 });
    expect(r.fadeIn + r.fadeOut).toBeLessThanOrEqual(3);
    // vo 入点 0：不能再往左拉
    expect(applyDrag(p, { kind: 'audio', id: 'vo', mode: 'start' }, -2, null).project.audio[1]).toMatchObject({ start: 3, inPoint: 0 });
    // bgm 起点 1、入点 10：往左最多 1 秒（起点到 0）
    expect(applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'start' }, -5, null).project.audio[0]).toMatchObject({ start: 0, inPoint: 9 });
    valid(applyDrag(p, { kind: 'audio', id: 'bgm', mode: 'start' }, 99, null).project);
  });

  it('字幕整体平移保持时长；拖边改起止', () => {
    const p = sampleProject();
    expect(applyDrag(p, { kind: 'cue', id: 'c3', mode: 'move' }, 1, null).project.subtitles.cues[2]).toMatchObject({ start: 6, end: 7 });
    expect(applyDrag(p, { kind: 'cue', id: 'c3', mode: 'move' }, -9, null).project.subtitles.cues[2]).toMatchObject({ start: 0, end: 1 });
    expect(applyDrag(p, { kind: 'cue', id: 'c3', mode: 'end' }, 2, null).project.subtitles.cues[2]).toMatchObject({ start: 5, end: 8 });
    expect(applyDrag(p, { kind: 'cue', id: 'c3', mode: 'start' }, 3, null).project.subtitles.cues[2]).toMatchObject({ start: 5.9, end: 6 });
  });

  it('找不到片段时原样返回', () => {
    const p = sampleProject();
    expect(applyDrag(p, { kind: 'cue', id: 'nope', mode: 'move' }, 1, null).project).toBe(p);
  });
});

describe('分割与复制', () => {
  it('视频在播放头处分割：两半入出点相接，后半段被选中', () => {
    const r = splitSelectionAt(sampleProject(), { kind: 'video', id: 'a' }, 1.5, ids);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.project.video.slice(0, 2)).toMatchObject([
      { id: 'a', inPoint: 2, outPoint: 3.5 },
      { inPoint: 3.5, outPoint: 6 },
    ]);
    expect(r.selection).toEqual({ kind: 'video', id: r.project.video[1].id });
    expect(layoutVideoTrack(r.project).at(-1)?.end).toBe(9);
    valid(r.project);
  });

  it('图片 / 音频 / 字幕分割；离边太近或不在片段内返回 null', () => {
    const p = sampleProject();
    expect(splitSelectionAt(p, { kind: 'video', id: 'img' }, 5, ids)?.project.video.slice(1, 3)).toMatchObject([{ duration: 1 }, { duration: 1 }]);
    const a = splitSelectionAt(p, { kind: 'audio', id: 'bgm' }, 3, ids);
    expect(a?.project.audio.slice(0, 2)).toMatchObject([
      { id: 'bgm', start: 1, inPoint: 10, outPoint: 12, fadeOut: 0, fadeIn: 1 },
      { start: 3, inPoint: 12, outPoint: 14, fadeIn: 0, fadeOut: 2 },
    ]);
    if (a) valid(a.project);
    expect(splitSelectionAt(p, { kind: 'cue', id: 'c1' }, 1, ids)?.project.subtitles.cues.slice(0, 2)).toMatchObject([
      { id: 'c1', start: 0, end: 1, text: 'one' },
      { start: 1, end: 2, text: 'one' },
    ]);
    expect(splitSelectionAt(p, { kind: 'video', id: 'a' }, 0.05, ids)).toBeNull();
    expect(splitSelectionAt(p, { kind: 'video', id: 'a' }, 7, ids)).toBeNull();
    expect(splitSelectionAt(p, null, 1, ids)).toBeNull();
  });

  it('复制：视频插在后面，音频 / 字幕接在原片段结束处，id 唯一', () => {
    const p = sampleProject();
    const v = duplicateSelection(p, { kind: 'video', id: 'img' }, ids);
    expect(v?.project.video.map((c) => c.type)).toEqual(['video', 'image', 'image', 'video']);
    const a = duplicateSelection(p, { kind: 'audio', id: 'vo' }, ids);
    expect(a?.project.audio[2]).toMatchObject({ start: 8, inPoint: 0, outPoint: 5 });
    const c = duplicateSelection(p, { kind: 'cue', id: 'c1' }, ids);
    expect(c?.project.subtitles.cues.map((x) => [x.start, x.end])).toEqual([[0, 2], [1.5, 3], [2, 4], [5, 6]]);
    for (const r of [v, a, c]) if (r) valid(r.project);
    expect(duplicateSelection(p, { kind: 'audio', id: 'nope' }, ids)).toBeNull();
  });
});
