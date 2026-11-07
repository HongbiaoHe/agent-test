/**
 * 剪辑工程文件在工作区里的读写：路径一律是工作区相对路径，解析后必须仍在工作区内（防 .. 与软链出域）。
 * 工具（create / check_video_project）与 video.* RPC 共用。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  parseProject,
  PROJECT_FILE_SUFFIX,
  projectDuration,
  type VideoProject,
} from '@agent-test/video-schema';
import type { VideoProjectFile, VideoProjectSummary } from '../../shared/rpc';
import { hostI18n } from '../i18n';
import { resolveInside, WorkspacePathError } from '../workspace/files';

/** 列工程时最多往下扫几层目录（工作区根算第 0 层） */
const LIST_MAX_DEPTH = 4;
/** 列工程时最多扫多少个目录（防止误选了一个巨大的目录卡住） */
const LIST_MAX_DIRS = 2000;
const SKIP_DIRS = new Set(['node_modules']);

/** 绝对路径 → 工作区相对路径（/ 分隔） */
export function toWorkspaceRel(realRoot: string, abs: string): string {
  return relative(realRoot, abs).split(sep).join('/');
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * 要写入（可能还不存在）的文件：先按字面确认在工作区内，再建父目录、realpath 父目录确认没经软链出域。
 * 返回真实绝对路径。
 */
export async function resolveWritable(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  const lexical = resolve(realRoot, rel);
  if (lexical === realRoot || !isInside(realRoot, lexical)) {
    throw new WorkspacePathError(hostI18n.t('errors.workspace.outside', { path: rel }));
  }
  await mkdir(dirname(lexical), { recursive: true });
  const parent = await realpath(dirname(lexical));
  if (!isInside(realRoot, parent)) {
    throw new WorkspacePathError(hostI18n.t('errors.workspace.outside', { path: rel }));
  }
  return join(parent, basename(lexical));
}

/**
 * 已存在的文件：先按字面拒掉出域路径（.. / 工作区外的绝对路径），免得报出「文件不存在」并带出工作区外的路径；
 * 再交给 resolveInside 按真实路径（含软链）确认。
 */
export async function resolveExisting(root: string, rel: string): Promise<string> {
  const realRoot = await realpath(root);
  if (!isInside(realRoot, resolve(realRoot, rel))) {
    throw new WorkspacePathError(hostI18n.t('errors.workspace.outside', { path: rel }));
  }
  return resolveInside(root, rel);
}

export function assertProjectPath(rel: string): void {
  if (!rel.endsWith(PROJECT_FILE_SUFFIX)) throw new Error(hostI18n.t('errors.video.notProject', { path: rel }));
}

/** 名字 → 文件名用的 slug：保留字母数字与中日韩文字，其余换成 -；空了用 video */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'video';
}

async function exists(abs: string): Promise<boolean> {
  return stat(abs).then(
    () => true,
    () => false,
  );
}

/** `<dir>/<base><ext>` 已存在就依次试 `-2`、`-3`……返回第一个不存在的工作区相对路径 */
export async function uniqueWorkspacePath(root: string, dir: string, base: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const rel = `${dir}/${base}${n === 1 ? '' : `-${n}`}${ext}`;
    if (!(await exists(join(root, rel)))) return rel;
  }
}

/** 原子写：先写同目录临时文件再 rename，读方（编辑器 / 文件监听）不会看到半截 JSON */
export async function writeFileAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function serializeProject(project: VideoProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/** 读并校验工程：JSON 坏了 / schema 不过都不抛，project 为 null + issues */
export async function readProjectFile(root: string, rel: string): Promise<VideoProjectFile> {
  assertProjectPath(rel);
  const abs = await resolveExisting(root, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new WorkspacePathError(hostI18n.t('errors.workspace.notFile', { path: rel }));
  const text = await readFile(abs, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { path: rel, project: null, issues: [`JSON: ${e instanceof Error ? e.message : String(e)}`], mtimeMs: st.mtimeMs };
  }
  const parsed = parseProject(raw);
  return parsed.ok
    ? { path: rel, project: parsed.project, issues: [], mtimeMs: st.mtimeMs }
    : { path: rel, project: null, issues: parsed.issues, mtimeMs: st.mtimeMs };
}

/** 工程引用的全部素材路径（去重，按出现顺序） */
export function projectSources(project: VideoProject): string[] {
  return [...new Set([...project.video.map((c) => c.src), ...project.audio.map((c) => c.src)])];
}

/** 工作区里不存在（或不是文件、或出域）的素材路径 */
export async function missingSources(root: string, project: VideoProject): Promise<string[]> {
  const missing: string[] = [];
  for (const src of projectSources(project)) {
    const ok = await resolveExisting(root, src).then(
      async (abs) => (await stat(abs)).isFile(),
      () => false,
    );
    if (!ok) missing.push(src);
  }
  return missing;
}

/** 扫描工作区里的 *.sparkvideo.json（深度有限，跳过隐藏目录与 node_modules），按修改时间倒序 */
export async function listProjects(root: string): Promise<VideoProjectSummary[]> {
  const realRoot = await realpath(root);
  const out: VideoProjectSummary[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: realRoot, depth: 0 }];
  // 广度优先：queue 只追加不删除，i 即已扫目录数
  for (let i = 0; i < queue.length && i < LIST_MAX_DIRS; i++) {
    const { dir, depth } = queue[i];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const d of entries) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      const abs = join(dir, d.name);
      // 不跟随软链目录：避免出域与环
      if (d.isDirectory()) {
        if (depth < LIST_MAX_DEPTH) queue.push({ dir: abs, depth: depth + 1 });
      } else if (d.isFile() && d.name.endsWith(PROJECT_FILE_SUFFIX)) {
        const rel = toWorkspaceRel(realRoot, abs);
        const file = await readProjectFile(realRoot, rel).catch(() => null);
        if (!file) continue;
        out.push({
          path: rel,
          name: file.project?.name ?? d.name.slice(0, -PROJECT_FILE_SUFFIX.length),
          duration: file.project ? projectDuration(file.project) : null,
          mtimeMs: file.mtimeMs,
        });
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
