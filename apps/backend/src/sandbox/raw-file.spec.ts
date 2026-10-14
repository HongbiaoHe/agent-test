import {
  contentDisposition,
  contentTypeFor,
  isInlineSafe,
  parseRange,
  RawFileCache,
} from './raw-file';

describe('contentTypeFor / isInlineSafe', () => {
  it('按扩展名推断，大小写不敏感，未知 → octet-stream', () => {
    expect(contentTypeFor('out/01-trim.MP4')).toBe('video/mp4');
    expect(contentTypeFor('a/b.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('Makefile')).toBe('application/octet-stream');
  });

  it('只有音视频与非 SVG 图片可内联；HTML/SVG/PDF 强制下载（防同源 XSS）', () => {
    expect(isInlineSafe('video/mp4')).toBe(true);
    expect(isInlineSafe('audio/mpeg')).toBe(true);
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
    expect(isInlineSafe('application/pdf')).toBe(false);
  });
});

describe('parseRange', () => {
  it('无 Range → null（返回全量 200）', () => {
    expect(parseRange(undefined, 100)).toBeNull();
  });
  it('bytes=0- → 全段', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
  });
  it('bytes=10-19 / 结尾越界截断到 size-1', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
  });
  it('后缀范围 bytes=-10 → 最后 10 字节', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });
  it('起点越界 / 起点大于终点 / 后缀 0 → unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
  it('多段 / 非法格式 → 忽略（null）', () => {
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('ASCII 兜底名 + UTF-8 文件名，中文不乱码', () => {
    expect(contentDisposition('out/成片.mp4', 'attachment')).toBe(
      `attachment; filename="__.mp4"; filename*=UTF-8''${encodeURIComponent('成片.mp4')}`,
    );
    expect(contentDisposition('a/clip.mp4', 'inline')).toBe(
      `inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });
});

describe('RawFileCache', () => {
  const bytes = (n: number) => new Uint8Array(n);

  it('命中 / 过期', () => {
    const c = new RawFileCache(1000, 100, 1000);
    c.set('a', bytes(10), 0);
    expect(c.get('a', 500)?.length).toBe(10);
    expect(c.get('a', 1000)).toBeUndefined();
  });

  it('超过单条上限不缓存', () => {
    const c = new RawFileCache(1000, 100, 1000);
    c.set('big', bytes(101), 0);
    expect(c.get('big', 0)).toBeUndefined();
  });

  it('超过总量按插入顺序淘汰最旧', () => {
    const c = new RawFileCache(1000, 100, 150);
    c.set('a', bytes(80), 0);
    c.set('b', bytes(80), 0);
    expect(c.get('a', 0)).toBeUndefined();
    expect(c.get('b', 0)?.length).toBe(80);
  });
});
