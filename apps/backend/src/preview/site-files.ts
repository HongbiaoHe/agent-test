import { contentTypeFor } from '../sandbox/raw-file';

/**
 * 静态网页预览（文件会话）的纯逻辑：请求路径 → 工作区文件、响应头。独立文件便于单测。
 */

/**
 * 请求路径 → 要读的工作区相对路径；越出站点根（..）或编码非法 → null。
 * - 去掉 query / hash，逐段 URL 解码（文件名可能含中文或空格）；
 * - 以 / 结尾（含根 /）补 index.html，与常见静态服务器一致；
 * - root 是会话里的站点根目录（工作区相对，'' = 工作区根）。
 */
export function resolveSitePath(root: string, rawUrl: string): string | null {
  const pathname = rawUrl.split(/[?#]/, 1)[0] || '/';
  let segments: string[];
  try {
    segments = pathname.split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (
    segments.some((s) => s === '..' || s.includes('\\') || s.includes('\0'))
  ) {
    return null;
  }
  const parts = segments.filter((s) => s !== '' && s !== '.');
  if (pathname.endsWith('/')) parts.push('index.html');
  if (parts.length === 0) return null;
  return [root, ...parts].filter(Boolean).join('/');
}

/**
 * 静态文件的响应头。预览站点是独立的源（p-<id> 子域名），页面拿不到主站的 cookie / 存储，
 * 所以不需要再用 CSP sandbox 把它关进不透明源——那样 localStorage 等存储一用就抛 SecurityError。
 * - Referrer-Policy no-referrer：预览地址本身就是访问凭证，不能经 Referer 泄露给页面加载的外部资源；
 * - nosniff：按扩展名给的类型生效，不让浏览器把文本嗅探成可执行内容；
 * - no-store：agent 改完文件刷新即见；
 * - 文本类补 utf-8：agent 产物常含中文，缺 charset 时浏览器可能按 Latin-1 解码成乱码。
 */
export function fileResponseHeaders(path: string): Record<string, string> {
  const type = contentTypeFor(path);
  const textual =
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/manifest+json' ||
    type === 'image/svg+xml';
  return {
    'content-type': textual ? `${type}; charset=utf-8` : type,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}
