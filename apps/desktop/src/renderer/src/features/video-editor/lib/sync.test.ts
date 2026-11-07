import { describe, expect, it } from 'vitest';
import { classifyFileChange, saveStateOf } from './sync';

describe('video-file-changed：自己的写入 vs 外部修改', () => {
  const base = { knownMtimeMs: 1000, writing: false, dirty: false };

  it('mtime 等于自己写入 / 读取拿到的那一版：忽略', () => {
    expect(classifyFileChange({ ...base, mtimeMs: 1000 })).toBe('ignore');
    expect(classifyFileChange({ ...base, mtimeMs: 1000, dirty: true })).toBe('ignore');
  });

  it('比已知版本旧的过期事件：忽略', () => {
    expect(classifyFileChange({ ...base, mtimeMs: 900 })).toBe('ignore');
  });

  it('写入在途：先缓一缓，写完再判', () => {
    expect(classifyFileChange({ ...base, mtimeMs: 2000, writing: true })).toBe('defer');
  });

  it('外部修改、本地干净：静默重载', () => {
    expect(classifyFileChange({ ...base, mtimeMs: 2000 })).toBe('reload');
  });

  it('外部修改、本地有没写回的改动：冲突', () => {
    expect(classifyFileChange({ ...base, mtimeMs: 2000, dirty: true })).toBe('conflict');
  });

  it('还没读到过版本号：按外部修改处理', () => {
    expect(classifyFileChange({ ...base, knownMtimeMs: null, mtimeMs: 1 })).toBe('reload');
  });
});

describe('保存状态', () => {
  it('保存中 / 未保存 / 已保存', () => {
    expect(saveStateOf({ saving: true, editVersion: 3, savedVersion: 3 })).toBe('saving');
    expect(saveStateOf({ saving: false, editVersion: 3, savedVersion: 2 })).toBe('unsaved');
    expect(saveStateOf({ saving: false, editVersion: 3, savedVersion: 3 })).toBe('saved');
  });
});
