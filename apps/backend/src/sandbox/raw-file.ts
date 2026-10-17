/**
 * 沙箱文件原始字节响应的纯逻辑（GET /sandbox/file/raw）：MIME 推断、内联白名单、
 * HTTP Range 解析、Content-Disposition 与短时缓存。独立文件便于单测。
 */

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  srt: 'text/plain',
  zip: 'application/zip',
  // 网页预览（静态文件会话，见 preview/site-files.ts）用到的前端资源类型
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  map: 'application/json',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export function contentTypeFor(path: string): string {
  const name = path.split('/').pop() ?? '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * 是否允许 inline 展示。接口经前端同源反代（/api-backend）访问且自动带登录态，
 * 若内联返回 agent 写出的 HTML/SVG，其中脚本能以用户身份调用接口（XSS）。
 * 故只放行不会执行脚本的媒体类型；其余一律 attachment 强制下载。
 */
export function isInlineSafe(contentType: string): boolean {
  return (
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    (contentType.startsWith('image/') && contentType !== 'image/svg+xml')
  );
}

/** 解析单段 Range 头（bytes=start-end / bytes=start- / bytes=-suffix）。 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // 多段 / 非 bytes 单位：忽略 Range，按 200 返回全量（RFC 9110 允许）
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    // 后缀范围：最后 N 字节
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Content-Disposition：ASCII 兜底名 + RFC 5987 UTF-8 文件名（中文名下载不乱码）。 */
export function contentDisposition(
  path: string,
  type: 'inline' | 'attachment',
): string {
  const name = path.split('/').pop() || 'file';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 原始文件短时缓存：<video> 拖动进度条会对同一文件发多次 Range 请求，沙箱只能整文件下载，
 * 不缓存每次都要重新从沙箱拉全量。按插入顺序淘汰；超大文件不缓存。
 */
export class RawFileCache {
  private readonly entries = new Map<
    string,
    { data: Uint8Array; expiresAt: number }
  >();
  private total = 0;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntryBytes = 64 * 1024 * 1024,
    private readonly maxTotalBytes = 256 * 1024 * 1024,
  ) {}

  get(key: string, now = Date.now()): Uint8Array | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    return e.data;
  }

  set(key: string, data: Uint8Array, now = Date.now()): void {
    if (data.length > this.maxEntryBytes) return;
    this.delete(key);
    this.entries.set(key, { data, expiresAt: now + this.ttlMs });
    this.total += data.length;
    for (const k of this.entries.keys()) {
      if (this.total <= this.maxTotalBytes) break;
      this.delete(k);
    }
  }

  private delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.total -= e.data.length;
    this.entries.delete(key);
  }
}
