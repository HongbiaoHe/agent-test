import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures';
import { removeSelection } from './edit';
import { duplicateSelection, splitSelectionAt } from './timeline-edit';
import { applyTransitionToAll, customTransitionsOf, seamsOf, setTransition } from './transition-edit';

const custom = { type: 'custom' as const, duration: 0.5, expr: 'if(lt(X,W/2),A,B)', name: '对开' };

describe('转场编辑', () => {
  it('设 / 去转场；接缝按钮位置在重叠区中点', () => {
    let p = setTransition(sampleProject(), 'a', { type: 'wipeleft', duration: 1 });
    expect(p.video[0].transition?.type).toBe('wipeleft');
    // a 段 [0, 4)，img 从 3 秒开始：接缝在 3.5
    expect(seamsOf(p).map((s) => [s.from.clip.id, s.to.clip.id, s.at])).toEqual([
      ['a', 'img', 3.5],
      ['img', 'b', 5],
    ]);
    p = removeSelection(p, { kind: 'transition', id: 'a' });
    expect('transition' in p.video[0]).toBe(false);
  });

  it('应用到全部接缝：最后一段不加', () => {
    const p = applyTransitionToAll(sampleProject(), { type: 'fade', duration: 0.5 });
    expect(p.video.map((c) => c.transition?.type ?? null)).toEqual(['fade', 'fade', null]);
  });

  it('自定义转场按表达式去重，供其他接缝复用', () => {
    let p = setTransition(sampleProject(), 'a', custom);
    p = setTransition(p, 'img', { ...custom, name: '另一个名字' });
    expect(customTransitionsOf(p)).toEqual([custom]);
  });

  it('分割：前半段硬切、转场留给后半段；选中接缝时不能分割 / 复制', () => {
    const p = setTransition(sampleProject(), 'a', { type: 'fade', duration: 0.5 });
    const r = splitSelectionAt(p, { kind: 'video', id: 'a' }, 2, () => 'tail');
    expect(r?.project.video.map((c) => [c.id, c.transition?.type ?? null])).toEqual([
      ['a', null],
      ['tail', 'fade'],
      ['img', null],
      ['b', null],
    ]);
    expect(splitSelectionAt(p, { kind: 'transition', id: 'a' }, 2)).toBeNull();
    expect(duplicateSelection(p, { kind: 'transition', id: 'a' })).toBeNull();
  });
});
