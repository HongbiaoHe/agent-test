import { describe, expect, it } from 'vitest';
import { sampleProject } from './fixtures';
import { type DocState, docReducer, initialDocState } from './document';

const file = (mtimeMs: number) => ({ path: 'videos/a.sparkvideo.json', project: sampleProject(), issues: [], mtimeMs });
const loaded = (mtimeMs = 1000): DocState => docReducer(initialDocState, { type: 'loaded', file: file(mtimeMs) });
const edited = (s: DocState, at = 0): DocState => {
  if (!s.history) throw new Error('not loaded');
  return docReducer(s, { type: 'edit', project: { ...s.history.present, name: `n${at}` }, at });
};

describe('文档状态机：自己的写入与外部修改', () => {
  it('自己写入触发的事件（mtime 等于写入返回值）被忽略', () => {
    let s = edited(loaded());
    s = docReducer(s, { type: 'saveStart' });
    s = docReducer(s, { type: 'saved', version: s.editVersion, mtimeMs: 2000 });
    const after = docReducer(s, { type: 'fileChanged', mtimeMs: 2000 });
    expect(after).toBe(s);
  });

  it('事件比写入响应先到：先缓着，写完按新 mtime 认出是自己的', () => {
    let s = edited(loaded());
    s = docReducer(s, { type: 'saveStart' });
    s = docReducer(s, { type: 'fileChanged', mtimeMs: 2000 });
    expect(s.deferredMtimeMs).toBe(2000);
    s = docReducer(s, { type: 'saved', version: s.editVersion, mtimeMs: 2000 });
    expect(s.conflict).toBeNull();
    expect(s.reloadToken).toBe(0);
  });

  it('外部修改、本地干净：静默重载', () => {
    const s = docReducer(loaded(), { type: 'fileChanged', mtimeMs: 3000 });
    expect(s.reloadToken).toBe(1);
    expect(s.conflict).toBeNull();
  });

  it('外部修改、本地有未写回的改动：冲突提示', () => {
    const s = docReducer(edited(loaded()), { type: 'fileChanged', mtimeMs: 3000 });
    expect(s.conflict).toBe('external');
  });

  it('写回时 baseMtimeMs 不符：冲突；强制写入成功后清掉冲突', () => {
    let s = edited(loaded());
    s = docReducer(s, { type: 'saveStart' });
    s = docReducer(s, { type: 'saveConflict', mtimeMs: 5000 });
    expect(s.conflict).toBe('write');
    expect(s.mtimeMs).toBe(1000);
    s = docReducer(s, { type: 'saveStart' });
    s = docReducer(s, { type: 'saved', version: s.editVersion, mtimeMs: 6000 });
    expect(s.conflict).toBeNull();
    expect(s.editVersion).toBe(s.savedVersion);
  });

  it('重新加载丢弃本地改动与撤销栈', () => {
    let s = edited(loaded());
    s = docReducer(s, { type: 'fileChanged', mtimeMs: 3000 });
    s = docReducer(s, { type: 'loaded', file: file(3000) });
    expect(s.conflict).toBeNull();
    expect(s.history?.past).toEqual([]);
    expect(s.editVersion).toBe(s.savedVersion);
  });

  it('损坏的文件：invalid + issues', () => {
    const s = docReducer(initialDocState, { type: 'loaded', file: { path: 'x', project: null, issues: ['bad'], mtimeMs: 1 } });
    expect(s.phase).toBe('invalid');
    expect(s.issues).toEqual(['bad']);
  });
});

describe('文档状态机：撤销合并', () => {
  it('同一字段 1 秒内的连续改动合并成一步，撤销 / 重做都算一次编辑', () => {
    let s = loaded();
    const base = s.history?.present;
    if (!base) throw new Error('not loaded');
    s = docReducer(s, { type: 'edit', project: { ...base, name: 'a' }, key: 'name', at: 0 });
    s = docReducer(s, { type: 'edit', project: { ...base, name: 'ab' }, key: 'name', at: 500 });
    s = docReducer(s, { type: 'edit', project: { ...base, name: 'abc' }, key: 'name', at: 2000 });
    expect(s.history?.past.map((p) => p.name)).toEqual(['demo', 'ab']);
    const v = s.editVersion;
    s = docReducer(s, { type: 'undo' });
    expect(s.history?.present.name).toBe('ab');
    expect(s.editVersion).toBe(v + 1);
  });
});
