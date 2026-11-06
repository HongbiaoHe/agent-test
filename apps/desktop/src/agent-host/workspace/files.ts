/**
 * 右上角「工作区文件」面板的数据：列目录（单层、懒加载）与文件预览。
 *
 * 口径对照 backend agent/sandbox.ts 的 listDir / readFilePreview（隐藏点文件与 node_modules、
 * 目录在前；文本最多 2000 行，图片转 dataUrl，其余只给大小）。桌面端工作区就是本机目录，
 * 直接用 fs 读，不经 agent 的沙箱包装；路径一律先 realpath 再确认仍在工作区内（防 ../ 与软链出域）。
 */
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import type { DirEntry, FilePreview } from '../../shared/rpc';
import { hostI18n } from '../i18n';

const HIDDEN_NAMES = new Set(['node_modules']);
const PREVIEW_MAX_LINES = 2000;
/** 文本预览最多读的字节数（2000 行的长行文件也不至于把整份大文件读进内存） */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const TEXT_EXTS = new Set(
  (
    'ts tsx js jsx mjs cjs json jsonc py rb go rs java kt c h cpp hpp cc cs php swift sh bash zsh fish ' +
    'sql graphql gql css scss sass less html htm xml vue svelte md markdown mdx txt text log yml yaml ' +
    'toml ini conf cfg env csv tsv properties gitignore dockerignore editorconfig'
  ).split(' '),
);
const TEXT_NOEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'procfile']);
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

export class WorkspacePathError extends Error {}

/** 工作区相对路径 → 真实绝对路径；出域（含经软链出域）抛 WorkspacePathError */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(join(realRoot, rel || '.'));
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new WorkspacePathError(hostI18n.t('errors.workspace.outside', { path: rel }));
  }
  return target;
}

export async function listDir(root: string, rel: string): Promise<DirEntry[]> {
  const dir = await resolveInside(root, rel);
  const realRoot = await realpath(root);
  const out: DirEntry[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') || HIDDEN_NAMES.has(d.name)) continue;
    const abs = join(dir, d.name);
    let isDir = d.isDirectory();
    let size = 0;
    if (d.isSymbolicLink() || d.isFile()) {
      try {
        const st = await stat(abs);
        isDir = st.isDirectory();
        size = st.isFile() ? st.size : 0;
      } catch {
        continue; // 断链
      }
    } else if (!isDir) {
      continue; // socket / fifo 等
    }
    out.push({ name: d.name, path: relative(realRoot, abs).split(sep).join('/'), isDir, size });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

export async function readFilePreview(root: string, rel: string): Promise<FilePreview> {
  const file = await resolveInside(root, rel);
  const st = await stat(file);
  if (!st.isFile()) throw new WorkspacePathError(hostI18n.t('errors.workspace.notFile', { path: rel }));
  const name = file.split(sep).pop() ?? '';
  const ext = extname(name).slice(1).toLowerCase();
  const isText = ext ? TEXT_EXTS.has(ext) : TEXT_NOEXT_NAMES.has(name.toLowerCase());

  if (isText) {
    const fh = await open(file, 'r');
    try {
      const len = Math.min(st.size, PREVIEW_MAX_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const lines = buf.toString('utf8').split('\n');
      const truncated = lines.length > PREVIEW_MAX_LINES || st.size > PREVIEW_MAX_BYTES;
      return { kind: 'text', content: lines.slice(0, PREVIEW_MAX_LINES).join('\n'), truncated };
    } finally {
      await fh.close();
    }
  }

  const mimeType = IMAGE_MIME[ext];
  if (mimeType && st.size <= IMAGE_MAX_BYTES) {
    const data = await readFile(file);
    return { kind: 'image', dataUrl: `data:${mimeType};base64,${data.toString('base64')}`, mimeType };
  }
  return { kind: 'binary', size: st.size };
}

