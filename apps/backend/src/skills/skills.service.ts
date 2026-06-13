/**
 * SkillsService — 技能注册表，两层数据源合并：
 *   1. 内置技能（磁盘，SKILLS_DIR）：随代码发布，永久启用。
 *   2. 用户安装技能（SKILLS_DATA_DIR/<userId>/<name>/）：来自 GitHub，存元数据行于 Prisma Skill 表。
 *
 * 设计决策：
 * - 同名时用户安装技能 **遮蔽（shadow）** 内置技能，与 npm 局部依赖覆盖全局的惯例一致。
 * - effectiveSkillsFor 只返回 enabled=true 的安装技能（运行时用）；
 *   listFor 同时返回 disabled 行（管理页需要让用户重新启用）。
 * - findMany 按 userId 一次取出，enabled 过滤在内存完成 → 减少 DB 往返，同时复用结果集。
 * - Env 解析 **延迟到方法调用时**（lazy）而非模块加载时，测试 beforeEach 设置的 env 才生效。
 *   沿用 command-registry.service.ts:18 的 getter 函数模式。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseSkillMd } from './skill-parser';

/** 技能分类：内置（随代码发布）或 GitHub 安装。 */
export type SkillKind = 'builtin' | 'github';

/** 技能定义：含完整文件内容，供 worker 注入虚拟 FS。 */
export interface SkillDef {
  name: string;
  description: string;
  /** 分类：由 source 派生，全链路（API/前端列表/补全面板）以此分组 */
  kind: SkillKind;
  /** 'builtin' 或 'github:...' 串 */
  source: 'builtin' | string;
  enabled: boolean;
  /** 相对路径 → 内容（含 SKILL.md） */
  files: Record<string, string>;
}

const kindOf = (source: string): SkillKind =>
  source === 'builtin' ? 'builtin' : 'github';

// 惰性求值：测试 beforeEach 赋值的 env 在方法调用时才被读取，避免模块加载时快照旧值。
// 模式沿用 command-registry.service.ts:18。
const builtinDir = () =>
  process.env.SKILLS_DIR ?? join(process.cwd(), 'skills');
const dataDir = () =>
  process.env.SKILLS_DATA_DIR ?? join(process.cwd(), 'data', 'skills');

/** 单文件大小上限，超出（多半是二进制资产）跳过，避免注入垃圾内容撑大 state。
 *  与 command-registry.service.ts:21 保持一致。 */
const MAX_SKILL_FILE_BYTES = 512 * 1024;

/**
 * 递归读取技能目录下全部文本文件，返回 相对路径(用 / 分隔) → 内容。
 * 迁移自 command-registry.service.ts:24 的 readSkillFiles；
 * 跳过 .git、.DS_Store 与超大文件，key 用 / 而非系统 sep。
 */
function readSkillFiles(skillDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === '.DS_Store') continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      if (statSync(abs).size > MAX_SKILL_FILE_BYTES) continue;
      const rel = relative(skillDir, abs).split(sep).join('/');
      out[rel] = readFileSync(abs, 'utf8');
    }
  };
  walk(skillDir);
  return out;
}

/**
 * 扫描指定根目录下的技能目录列表，构建 SkillDef 列表。
 * 没有 SKILL.md 的子目录直接跳过（不是技能目录）。
 * 目录不存在时返回空数组（用户尚未安装任何技能的正常状态）。
 */
function scanSkillDir(
  rootDir: string,
  source: 'builtin' | string,
  enabled: boolean,
): SkillDef[] {
  if (!existsSync(rootDir)) return [];

  const result: SkillDef[] = [];
  for (const entry of readdirSync(rootDir)) {
    const entryDir = join(rootDir, entry);
    // 跳过非目录项（如 .DS_Store 文件）
    if (!existsSync(entryDir) || !statSync(entryDir).isDirectory()) continue;

    const skillPath = join(entryDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue; // 没有 SKILL.md → 不是合法技能目录

    const files = readSkillFiles(entryDir);
    const raw = files['SKILL.md'] ?? readFileSync(skillPath, 'utf8');
    const parsed = parseSkillMd(raw, entry);
    const name = parsed.name;

    result.push({
      name,
      description: parsed.description,
      kind: kindOf(source),
      source,
      enabled,
      files,
    });
  }
  return result;
}

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查出用户在 DB 中的安装技能行，并按行元数据扫描磁盘目录，
   * 返回 Map<name, SkillDef>（内存过滤 enabled）。
   *
   * 单次 findMany 取全部行，caller 按需过滤 enabled，减少 DB 往返。
   */
  private async buildInstalledMap(
    userId: string,
    includeDisabled: boolean,
  ): Promise<Map<string, SkillDef>> {
    const rows: Array<{ name: string; enabled: boolean; source: string }> =
      await this.prisma.skill.findMany({ where: { userId } });

    const userDir = join(dataDir(), userId);
    const map = new Map<string, SkillDef>();

    for (const row of rows) {
      // 按方法语义决定是否跳过 disabled 行
      if (!includeDisabled && !row.enabled) continue;

      const entryDir = join(userDir, row.name);
      if (!existsSync(entryDir) || !statSync(entryDir).isDirectory()) {
        // 磁盘文件已消失但 DB 行还在：仍返回元数据（无文件），不抛错
        map.set(row.name, {
          name: row.name,
          description: '',
          kind: kindOf(row.source),
          source: row.source,
          enabled: row.enabled,
          files: {},
        });
        continue;
      }

      const skillPath = join(entryDir, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      const files = readSkillFiles(entryDir);
      const raw = files['SKILL.md'] ?? readFileSync(skillPath, 'utf8');
      const parsed = parseSkillMd(raw, row.name);

      map.set(row.name, {
        name: parsed.name,
        description: parsed.description,
        kind: kindOf(row.source),
        source: row.source,
        enabled: row.enabled,
        files,
      });
    }

    return map;
  }

  /**
   * 运行时有效技能列表（含文件内容）：
   * - 全部内置技能（enabled:true, source:'builtin'）
   * - 用户 enabled=true 的安装技能
   * - 同名时：用户安装技能遮蔽内置技能（Map 覆盖）
   */
  async effectiveSkillsFor(userId: string): Promise<SkillDef[]> {
    // 先构建内置技能 Map
    const builtins = scanSkillDir(builtinDir(), 'builtin', true);
    const map = new Map<string, SkillDef>(builtins.map((s) => [s.name, s]));

    // 用户安装（仅 enabled）覆盖同名内置
    const installed = await this.buildInstalledMap(userId, false);
    for (const [name, def] of installed) {
      map.set(name, def);
    }

    return [...map.values()];
  }

  /**
   * 列表/详情共享的合并视图（含 disabled 安装行，同名安装遮蔽内置）。
   * listFor 在此之上剥离 files；detailFor 保留 files。
   */
  private async mergedMapFor(userId: string): Promise<Map<string, SkillDef>> {
    const builtins = scanSkillDir(builtinDir(), 'builtin', true);
    const map = new Map<string, SkillDef>(builtins.map((s) => [s.name, s]));
    const installed = await this.buildInstalledMap(userId, true);
    for (const [name, def] of installed) {
      map.set(name, def);
    }
    return map;
  }

  /**
   * 管理页用：同 effectiveSkillsFor 的合并逻辑，但 **含 disabled 安装行**，
   * 以便前端能展示并允许用户重新启用。不含文件内容（节省传输）。
   */
  async listFor(userId: string): Promise<Omit<SkillDef, 'files'>[]> {
    const map = await this.mergedMapFor(userId);
    return [...map.values()].map(({ files: _f, ...rest }) => rest);
  }

  /**
   * 按名查单条技能（覆盖感知）：
   * 若用户有同名安装技能（且 enabled），返回用户版本；否则返回内置版本。
   */
  async getFor(userId: string, name: string): Promise<SkillDef | undefined> {
    const all = await this.effectiveSkillsFor(userId);
    return all.find((d) => d.name === name);
  }

  /** 技能详情（管理页用，listFor 同语义：含 disabled）。files 只回路径列表，SKILL.md 单独回原文。 */
  async detailFor(
    userId: string,
    name: string,
  ): Promise<
    (Omit<SkillDef, 'files'> & { files: string[]; skillMd: string }) | undefined
  > {
    const def = (await this.mergedMapFor(userId)).get(name);
    if (!def) return undefined;
    const { files, ...rest } = def;
    return {
      ...rest,
      files: Object.keys(files).sort(),
      skillMd: files['SKILL.md'] ?? '',
    };
  }
}
