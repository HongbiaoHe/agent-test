/**
 * 从 GitHub 安装开源技能，命令写法兼容开放技能生态的 `npx skills add`（skills.sh）：
 *
 *   npx skills add anthropics/skills --skill skill-creator
 *   /skills add vercel-labs/agent-skills@frontend-design
 *   https://github.com/owner/repo/tree/main/skills/my-skill
 *
 * 不依赖用户电脑上的 Node / git：直接拉 codeload tarball（同 backend skill-installer），
 * 解压时与 backend 同样的防护——只要普通文件与目录（丢弃软链 / 硬链等）、拒绝 `..` 与绝对路径、
 * 单文件 >512KB 跳过、解压总量封顶；然后在仓库里找所有含 SKILL.md 的目录，按 --skill 过滤后逐个交给
 * SkillStore.installFromFolder 校验落库。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { parseSkillMd } from '@agent-test/agent-core/skills/skill-parser';
import * as tar from 'tar';
import { hostI18n } from '../i18n';

const MAX_FILE_BYTES = 512 * 1024;
/** 整个仓库解压后的上限（只统计保留下来的文件） */
const MAX_EXTRACT_BYTES = 50 * 1024 * 1024;
/** 一次最多装多少个技能（仓库里技能很多又没指定 --skill 时防误装一大堆） */
export const MAX_SKILLS_PER_INSTALL = 30;
const SCAN_SKIP = new Set(['node_modules', '.git', '.github']);

export class GithubInstallError extends Error {}

export interface GithubSkillSource {
  owner: string;
  repo: string;
  ref?: string;
  /** 仓库内子目录（只在这里面找技能） */
  path?: string;
  /** --skill / @name 指定的技能名；空 = 仓库（或 path）下的全部技能 */
  skills: string[];
}

const NAME = /^[\w.-]+$/;

/** 「/skills add …」「npx skills add …」：返回 add 之后的参数串；不是安装命令返回 null */
export function skillsAddArgs(text: string): string | null {
  const m = /^\s*(?:\/skills|(?:npx\s+(?:-y\s+)?)?skills)\s+add\s+([\s\S]+)$/i.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * 解析安装来源（命令里 add 之后的部分，或直接一个仓库 / 链接）。认得：
 * owner/repo、owner/repo/sub/path、owner/repo@skill、github.com 链接（含 /tree/<ref>/<path>、
 * /blob/<ref>/<path>/SKILL.md、.git 后缀）、git@github.com:owner/repo.git；
 * 参数 --skill / -s <名字>（可重复、可逗号分隔），其余 skills CLI 参数（-y、-g、--agent x 等）忽略。
 */
export function parseSkillSource(input: string): GithubSkillSource {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const skills: string[] = [];
  let target: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--skill' || t === '-s') {
      const v = tokens[++i];
      if (v) skills.push(...v.split(',').filter(Boolean));
      continue;
    }
    if (t.startsWith('--skill=')) {
      skills.push(...t.slice('--skill='.length).split(',').filter(Boolean));
      continue;
    }
    if (t === '--agent' || t === '-a') {
      i++; // 跳过参数值
      continue;
    }
    if (t.startsWith('-')) continue;
    target ??= t;
  }
  if (!target) throw new GithubInstallError(hostI18n.t('errors.github.missingRepo'));

  let rest = target.replace(/^git@github\.com:/, 'https://github.com/');
  let ref: string | undefined;
  let path: string | undefined;
  const at = /^([^@]+)@([\w.-]+)$/.exec(rest);
  if (at && !rest.includes('://')) {
    rest = at[1];
    skills.push(at[2]);
  }
  let parts: string[];
  if (/^https?:\/\//.test(rest)) {
    const u = new URL(rest);
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
      throw new GithubInstallError(hostI18n.t('errors.github.githubOnly', { host: u.hostname }));
    }
    parts = u.pathname.split('/').filter(Boolean);
    const [owner, repo, kind, r, ...sub] = parts;
    if (!owner || !repo) throw new GithubInstallError(hostI18n.t('errors.github.badRepoUrl', { target }));
    if ((kind === 'tree' || kind === 'blob') && r) {
      ref = r;
      const p = sub.join('/');
      path = kind === 'blob' ? p.replace(/\/?SKILL\.md$/i, '') : p;
    }
    parts = [owner, repo.replace(/\.git$/, '')];
  } else {
    parts = rest.split('/').filter(Boolean);
    if (parts.length > 2) path = parts.slice(2).join('/');
    parts = parts.slice(0, 2);
  }
  const [owner, repo] = parts;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new GithubInstallError(hostI18n.t('errors.github.badRepo', { target }));
  }
  if (path && path.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new GithubInstallError(hostI18n.t('errors.github.dotPath'));
  }
  return { owner, repo: repo.replace(/\.git$/, ''), ref, path: path || undefined, skills };
}

/** 下载仓库 tarball：没指定 ref 时先 main 后 master（同 backend）；返回 tarball 与实际 ref */
async function download(src: GithubSkillSource): Promise<{ tarball: Buffer; ref: string }> {
  const refs = src.ref ? [src.ref] : ['main', 'master'];
  for (const ref of refs) {
    const url = `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${encodeURIComponent(ref)}`;
    const resp = await fetch(url);
    if (resp.ok) return { tarball: Buffer.from(await resp.arrayBuffer()), ref };
    if (resp.status !== 404) {
      throw new GithubInstallError(
        hostI18n.t('errors.github.downloadFailed', { status: resp.status, repo: `${src.owner}/${src.repo}`, ref }),
      );
    }
  }
  throw new GithubInstallError(
    src.ref
      ? hostI18n.t('errors.github.repoNotFound', { repo: `${src.owner}/${src.repo}@${src.ref}` })
      : hostI18n.t('errors.github.repoNotFoundDefault', { repo: `${src.owner}/${src.repo}` }),
  );
}

function assertSafeEntryPath(p: string): void {
  if (p.startsWith('/') || p.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) {
    throw new GithubInstallError(hostI18n.t('errors.github.unsafePath', { path: p }));
  }
}

/** 仓库里所有含 SKILL.md 的目录（相对仓库根），找到一个就不再往它里面找 */
async function findSkillDirs(root: string, dir = root, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [dir];
  if (depth >= 6) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || SCAN_SKIP.has(e.name)) continue;
    out.push(...(await findSkillDirs(root, join(dir, e.name), depth + 1)));
  }
  return out;
}

export interface FetchedSkill {
  /** 解压出的技能目录（临时目录里，cleanup 之后失效） */
  dir: string;
  /** 落库的来源串：github:owner/repo#path@ref（同 Web，供「更新」重装） */
  source: string;
}

/**
 * 下载并解压，返回要安装的技能目录。调用方装完后必须调 cleanup()。
 */
export async function fetchGithubSkills(
  src: GithubSkillSource,
): Promise<{ skills: FetchedSkill[]; cleanup: () => Promise<void> }> {
  const { tarball, ref } = await download(src);
  const tmp = await mkdtemp(join(tmpdir(), 'spark-skill-'));
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  try {
    const file = join(tmp, 'repo.tar.gz');
    await writeFile(file, tarball);
    const out = join(tmp, 'repo');
    await mkdir(out);
    let total = 0;
    const prefix = src.path ? `${src.path.replace(/\/$/, '')}/` : '';
    await tar.x({
      file,
      cwd: out,
      strip: 1, // 顶层 <repo>-<ref>/
      filter: (entryPath, entry) => {
        assertSafeEntryPath(entryPath);
        // 只要普通文件与目录：软链 / 硬链能指向树外，是 tarball 的经典攻击面
        if ('type' in entry && entry.type !== 'File' && entry.type !== 'Directory') return false;
        const inRepo = entryPath.split('/').slice(1).join('/');
        if (prefix && !(inRepo.startsWith(prefix) || `${inRepo}/` === prefix)) return false;
        if ('type' in entry && entry.type === 'File') {
          if ((entry.size ?? 0) > MAX_FILE_BYTES) return false;
          total += entry.size ?? 0;
          if (total > MAX_EXTRACT_BYTES) throw new GithubInstallError(hostI18n.t('errors.github.tooLarge'));
        }
        return true;
      },
    });
    const base = src.path ? join(out, ...src.path.split('/')) : out;
    let dirs = await findSkillDirs(base).catch(() => []);
    if (dirs.length === 0) {
      throw new GithubInstallError(
        hostI18n.t('errors.github.noSkillMd', {
          location: `${src.owner}/${src.repo}${src.path ? `/${src.path}` : ''}`,
        }),
      );
    }
    if (src.skills.length > 0) {
      const wanted = new Set(src.skills.map((s) => s.toLowerCase()));
      const named: string[] = [];
      for (const d of dirs) {
        const dirName = d.split(sep).pop() ?? '';
        const md = parseSkillMd(await readFile(join(d, 'SKILL.md'), 'utf8'), dirName);
        if (wanted.has(md.name.toLowerCase()) || wanted.has(dirName.toLowerCase())) named.push(d);
      }
      if (named.length === 0) {
        throw new GithubInstallError(hostI18n.t('errors.github.noNamedSkill', { names: src.skills.join(', ') }));
      }
      dirs = named;
    }
    if (dirs.length > MAX_SKILLS_PER_INSTALL) {
      throw new GithubInstallError(hostI18n.t('errors.github.tooMany', { count: dirs.length }));
    }
    return {
      skills: dirs.map((d) => ({
        dir: d,
        source: `github:${src.owner}/${src.repo}#${relative(out, d).split(sep).join('/') || '.'}@${ref}`,
      })),
      cleanup,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
