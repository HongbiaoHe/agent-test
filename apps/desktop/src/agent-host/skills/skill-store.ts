/**
 * 技能库（desktop 版 SkillsService，口径对照 apps/backend/src/skills/skills.service.ts）：
 * - 内置（builtin）：随应用发布在 resources/skills/，没有 DB 行、不能停用或删除，名字保留；
 * - GitHub：`/skills add owner/repo`（兼容 npx skills add 写法，见 github-install.ts）；
 * - 自定义（custom）：设置页手写，或 agent 用 create-skills + save_skill 生成；也可从本机文件夹导入。
 * 安装 / 保存都会校验 SKILL.md（parseSkillMd + validateSkill）与大小（单文件 512KB / 目录 20MB）。
 *
 * 每轮开跑前 syncToRuntime 把内置 + 已启用技能**同步**进 `<会话运行目录>/skills/`（不在用户工作区里）：
 * 该目录由 Spark 全权管理，先清空再复制，停用 / 删除的技能不会残留被模型看到。
 */
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseSkillMd, validateSkill } from '@agent-test/agent-core/skills/skill-parser';
import { z } from 'zod';
import type { SkillDetail, SkillInfo } from '../../shared/rpc';
import type { Db } from '../db/database';
import { fetchGithubSkills, type GithubSkillSource } from './github-install';

/** 单文件 / 目录总量上限，与 backend skill-installer 一致（512KB / 20MB） */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SKILL_DIR_BYTES = 20 * 1024 * 1024;
const MAX_BODY_CHARS = 100_000;

const skillRow = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.number(),
  source: z.string(),
  installed_at: z.number(),
});

function toInfo(r: z.infer<typeof skillRow>): SkillInfo {
  return {
    name: r.name,
    description: r.description,
    enabled: r.enabled === 1,
    source: r.source,
    kind: r.source.startsWith('github:') ? 'github' : 'custom',
    installedAt: r.installed_at,
  };
}

export class SkillInstallError extends Error {}

/** 手写技能的 SKILL.md：description 压成单行（parseSkillMd 按行取 frontmatter 值），同 backend buildCustomSkillMd */
export function buildCustomSkillMd(name: string, description: string, body: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n${body.trim()}\n`;
}

export class SkillStore {
  constructor(
    private readonly db: Db,
    /** 技能库根目录（userData/skills） */
    private readonly root: string,
    /** 内置技能目录（应用 resources/skills；测试可不传） */
    private readonly builtinRoot: string | null = null,
  ) {}

  /** 内置在前，其余按名字排序（同 Web 分组顺序） */
  async list(): Promise<SkillInfo[]> {
    const builtins = await this.builtins();
    const taken = new Set(builtins.map((b) => b.name));
    const installed = this.db
      .prepare('SELECT * FROM skill ORDER BY name')
      .all()
      .map((r) => toInfo(skillRow.parse(r)))
      .filter((s) => !taken.has(s.name));
    return [...builtins, ...installed];
  }

  async get(name: string): Promise<SkillInfo | null> {
    const builtin = (await this.builtins()).find((b) => b.name === name);
    if (builtin) return builtin;
    const r = this.db.prepare('SELECT * FROM skill WHERE name = ?').get(name);
    return r ? toInfo(skillRow.parse(r)) : null;
  }

  /** 已启用技能的 SKILL.md 原文（/command 激活技能后的多轮注入用）；未安装 / 停用返回 null */
  async skillMd(name: string): Promise<string | null> {
    const info = await this.get(name);
    if (!info?.enabled) return null;
    try {
      return await readFile(join(this.dirOf(info), 'SKILL.md'), 'utf8');
    } catch {
      return null;
    }
  }

  /** 详情：文件列表 + SKILL.md 原文 + 去掉 frontmatter 的正文（同 Web GET /skills/:name） */
  async detail(name: string): Promise<SkillDetail> {
    const info = await this.get(name);
    if (!info) throw new SkillInstallError(`技能不存在：${name}`);
    const dir = this.dirOf(info);
    const skillMd = await readFile(join(dir, 'SKILL.md'), 'utf8');
    const files = (await listFiles(dir)).map((f) => relative(dir, f.path).split(sep).join('/')).sort();
    return { ...info, files, skillMd, body: parseSkillMd(skillMd, name).body };
  }

  async installFromFolder(folder: string, source = `folder:${folder}`): Promise<SkillInfo> {
    const dirName = basename(folder);
    let raw: string;
    try {
      raw = await readFile(join(folder, 'SKILL.md'), 'utf8');
    } catch {
      throw new SkillInstallError(`所选文件夹里没有 SKILL.md：${folder}`);
    }
    const parsed = parseSkillMd(raw, dirName);
    const errors = validateSkill({
      name: parsed.name,
      description: parsed.description,
      dirName,
      compatibility: parsed.compatibility,
    });
    if (errors.length) throw new SkillInstallError(`技能 ${dirName} 校验失败：${errors.join('；')}`);
    await this.assertNotBuiltin(parsed.name);

    const files = await listFiles(folder);
    let total = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        throw new SkillInstallError(`文件过大（>512KB）：${relative(folder, f.path)}`);
      }
      total += f.size;
    }
    if (total > MAX_SKILL_DIR_BYTES) throw new SkillInstallError('技能目录总大小超过 20MB');

    const dest = join(this.root, parsed.name);
    await rm(dest, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    // 只复制普通文件与目录：跳过隐藏文件（.git 等）与软链（可能指向技能目录外）
    await cp(folder, dest, {
      recursive: true,
      filter: async (src) => {
        if (src === folder) return true;
        if (basename(src).startsWith('.')) return false;
        return !(await lstat(src)).isSymbolicLink();
      },
    });
    this.upsert(parsed.name, parsed.description, source);
    return this.require(parsed.name);
  }

  /** GitHub 安装（兼容 npx skills add 写法）：仓库里匹配的技能逐个校验落库 */
  async installFromGithub(src: GithubSkillSource): Promise<SkillInfo[]> {
    const { skills, cleanup } = await fetchGithubSkills(src);
    try {
      const out: SkillInfo[] = [];
      for (const s of skills) out.push(await this.installFromFolder(s.dir, s.source));
      return out;
    } finally {
      await cleanup();
    }
  }

  /**
   * 新建 / 覆盖自定义技能（设置页编辑器与 agent 的 save_skill 共用）。
   * files：附带的 references / scripts 等（相对技能目录的路径）；覆盖时整个目录重写。
   * 不能占用内置技能名；GitHub 装的技能也不能被覆盖（避免下次「更新」把改动冲掉）。
   */
  async saveCustom(input: {
    name: string;
    description: string;
    body: string;
    files?: { path: string; content: string }[];
    /** 编辑已有技能：名字必须已存在且是自定义技能 */
    mustExist?: boolean;
  }): Promise<SkillInfo> {
    const { name, description, body } = input;
    const errors = validateSkill({ name, description, dirName: name });
    if (errors.length) throw new SkillInstallError(errors.join('；'));
    if (body.length > MAX_BODY_CHARS) throw new SkillInstallError('正文超过 100000 字符');
    await this.assertNotBuiltin(name);
    const existing = await this.get(name);
    if (input.mustExist && !existing) throw new SkillInstallError(`技能不存在：${name}`);
    if (existing && existing.kind !== 'custom') {
      throw new SkillInstallError(`${name} 是从 GitHub 安装的技能，不能覆盖；换个名字`);
    }
    const extra = input.files ?? [];
    for (const f of extra) {
      const segs = f.path.split('/');
      if (!f.path || f.path.startsWith('/') || segs.some((s) => s === '..' || s.startsWith('.'))) {
        throw new SkillInstallError(`附带文件路径不合法：${f.path}`);
      }
      if (f.path === 'SKILL.md') throw new SkillInstallError('SKILL.md 由 description 与正文生成，不要放进附带文件');
      if (Buffer.byteLength(f.content) > MAX_FILE_BYTES) {
        throw new SkillInstallError(`附带文件过大（>512KB）：${f.path}`);
      }
    }
    const dest = join(this.root, name);
    // 编辑表单只改 SKILL.md；agent 带了附带文件时整目录重写
    if (extra.length > 0) await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), buildCustomSkillMd(name, description, body));
    for (const f of extra) {
      const p = join(dest, ...f.path.split('/'));
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, f.content);
    }
    this.upsert(name, description.replace(/\s+/g, ' ').trim(), existing?.source ?? 'custom');
    return this.require(name);
  }

  async setEnabled(name: string, enabled: boolean): Promise<SkillInfo> {
    await this.assertNotBuiltin(name, '内置技能不能停用');
    this.db.prepare('UPDATE skill SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
    return this.require(name);
  }

  async remove(name: string): Promise<void> {
    await this.assertNotBuiltin(name, '内置技能不能删除');
    this.db.prepare('DELETE FROM skill WHERE name = ?').run(name);
    await rm(join(this.root, name), { recursive: true, force: true });
  }

  /** 把内置 + 已启用技能同步到 `<runtimeDir>/skills/`（先清空再复制），返回同步了哪些技能 */
  async syncToRuntime(runtimeDir: string): Promise<string[]> {
    const target = join(runtimeDir, 'skills');
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const enabled = (await this.list()).filter((s) => s.enabled);
    for (const s of enabled) {
      await cp(this.dirOf(s), join(target, s.name), { recursive: true });
    }
    return enabled.map((s) => s.name);
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private dirOf(info: SkillInfo): string {
    return info.kind === 'builtin' && this.builtinRoot
      ? join(this.builtinRoot, info.name)
      : join(this.root, info.name);
  }

  private upsert(name: string, description: string, source: string): void {
    this.db
      .prepare(
        `INSERT INTO skill (name, description, enabled, source, installed_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, source = excluded.source,
         installed_at = excluded.installed_at`,
      )
      .run(name, description, source, Date.now());
  }

  private async require(name: string): Promise<SkillInfo> {
    const info = await this.get(name);
    if (!info) throw new SkillInstallError(`技能不存在：${name}`);
    return info;
  }

  private async assertNotBuiltin(name: string, msg = `${name} 是内置技能的名字，换一个`): Promise<void> {
    if ((await this.builtins()).some((b) => b.name === name)) throw new SkillInstallError(msg);
  }

  /** 内置技能：builtinRoot 下每个含合法 SKILL.md 的子目录（读不到 / 不合法的跳过） */
  private async builtins(): Promise<SkillInfo[]> {
    if (!this.builtinRoot) return [];
    const root = this.builtinRoot;
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
    const out: SkillInfo[] = [];
    for (const name of entries) {
      try {
        const md = parseSkillMd(await readFile(join(root, name, 'SKILL.md'), 'utf8'), name);
        if (validateSkill({ name: md.name, description: md.description, dirName: name }).length) continue;
        out.push({
          name,
          description: md.description,
          enabled: true,
          source: 'builtin',
          kind: 'builtin',
          installedAt: 0,
        });
      } catch {
        continue;
      }
    }
    return out;
  }
}

async function listFiles(dir: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p)));
    else if (entry.isFile()) out.push({ path: p, size: (await stat(p)).size });
  }
  return out;
}
