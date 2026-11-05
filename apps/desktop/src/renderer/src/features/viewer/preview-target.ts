/**
 * 对话里的链接 → 预览目标。纯函数，不碰 DOM / IPC（单测见 preview-target.test.ts）。
 *
 * - http(s) 链接：按 URL 路径的扩展名判断图片 / 视频 / 音频 / Markdown / 文本；认不出的返回 null（交给系统浏览器）；
 * - 其余（相对路径、本机绝对路径、file://）：当成当前会话工作区里的文件，交给 workspace.read 判断类型；
 *   绝对路径必须落在工作区目录下，否则返回 null（agent-host 也只读得到工作区内的文件）。
 */
export type RemoteKind = 'image' | 'video' | 'audio' | 'markdown' | 'text';

export type PreviewTarget =
  | { source: 'url'; url: string; kind: RemoteKind; name: string }
  | { source: 'workspace'; path: string; name: string };

const EXT_KIND: Record<string, RemoteKind> = {};
const register = (kind: RemoteKind, exts: string) => {
  for (const ext of exts.split(' ')) EXT_KIND[ext] = kind;
};
register('image', 'png jpg jpeg gif webp svg avif bmp ico');
register('video', 'mp4 webm mov m4v ogv');
register('audio', 'mp3 wav ogg oga m4a aac flac opus');
register('markdown', 'md markdown mdx');
register('text', 'txt text log csv tsv json jsonl yaml yml toml xml');

function extOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Markdown 预览 / 文本预览：按文件名决定用 Markdown 渲染还是代码查看器 */
export function isMarkdownName(name: string): boolean {
  return EXT_KIND[extOf(name)] === 'markdown';
}

export function remoteKindOf(url: string): RemoteKind | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  return EXT_KIND[extOf(pathname)] ?? null;
}

export function previewTargetOf(href: string, workspaceDir: string | null): PreviewTarget | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;

  if (/^https?:\/\//i.test(raw)) {
    const kind = remoteKindOf(raw);
    if (!kind) return null;
    const name = safeDecode(new URL(raw).pathname.split('/').pop() ?? '') || raw;
    return { source: 'url', url: raw, kind, name };
  }

  let path: string;
  if (/^file:\/\//i.test(raw)) {
    try {
      path = safeDecode(new URL(raw).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return null; // mailto: / data: / 其它协议：不预览
  } else {
    path = safeDecode(raw.split(/[?#]/)[0]);
  }

  if (path.startsWith('/')) {
    if (!workspaceDir) return null;
    const root = workspaceDir.replace(/\/+$/, '');
    if (!path.startsWith(`${root}/`)) return null;
    path = path.slice(root.length + 1);
  }
  path = path.replace(/^(\.\/)+/, '');
  if (!path || path.endsWith('/')) return null;
  return { source: 'workspace', path, name: path.split('/').pop() ?? path };
}
