import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { parseSkillMd, validateSkill } from '../skills/skill-parser';
import { readSkillFiles } from '../skills/skills.service';
import { buildSkillMd } from './skill-context';

/**
 * 画布 agent 的技能库：内置（磁盘 canvas-skills/，随代码发布，不可删、不可停用）+ 用户自建（CanvasSkill 表）。
 * 与主 agent 的 SkillsService 分开：画布 agent 没有沙箱，技能只是文本工作流说明，
 * 主 agent 那批依赖脚本执行的技能在这里用不了，混在一起只会让模型误用。
 */

export type CanvasSkillKind = 'builtin' | 'user';

export interface CanvasSkillSummary {
  name: string;
  description: string;
  kind: CanvasSkillKind;
  enabled: boolean;
  updatedAt: string | null;
}

/** 运行时用：含全部文件（相对路径 → 内容，至少有 SKILL.md） */
export interface CanvasSkillDef extends CanvasSkillSummary {
  files: Record<string, string>;
}

export type SaveSkillResult =
  /** skill：刚存下的那份（运行中直接补进技能库与清单，不必再整库重读） */
  | { ok: true; name: string; created: boolean; skill: CanvasSkillDef }
  | { ok: false; errors: string[] };

// 惰性求值：测试里改 env 在调用时才生效（同 SkillsService）
const builtinDir = () =>
  process.env.CANVAS_SKILLS_DIR ?? join(process.cwd(), 'canvas-skills');

/**
 * 技能正文上限（字符）。一份好技能通常 60–200 行、几千字；给到 3 万字足够宽裕。
 * 不设上限的话，模型写出超长正文会在 upsert 时撞列长度报错，而且之后每次 /调用 都要把它整份塞进上下文。
 */
export const MAX_INSTRUCTIONS_CHARS = 30_000;

/** 内置在前、用户在后，各自按名称——顺序决定清单文本，必须稳定 */
function bySkillOrder(a: CanvasSkillDef, b: CanvasSkillDef): number {
  if (a.kind !== b.kind) return a.kind === 'builtin' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** 把一份技能放进（启用的）技能列表：同名替换，顺序与 effectiveFor 的结果一致 */
export function upsertSkillDef(
  defs: readonly CanvasSkillDef[],
  def: CanvasSkillDef,
): CanvasSkillDef[] {
  return [...defs.filter((d) => d.name !== def.name), def].sort(bySkillOrder);
}

@Injectable()
export class CanvasSkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 内置技能随代码发布、进程内不会变：按目录读一次后缓存，免得每次列表/保存/每轮 run 都同步扫一遍磁盘。
   * 缓存键带上目录，测试里换 CANVAS_SKILLS_DIR 时自然失效。
   */
  private builtinCache: { dir: string; skills: CanvasSkillDef[] } | null = null;

  /** 内置技能：canvas-skills/<名>/SKILL.md（目录名即技能名） */
  builtins(): CanvasSkillDef[] {
    const root = builtinDir();
    if (this.builtinCache?.dir === root) return this.builtinCache.skills;
    const skills = this.loadBuiltins(root);
    this.builtinCache = { dir: root, skills };
    return skills;
  }

  private loadBuiltins(root: string): CanvasSkillDef[] {
    if (!existsSync(root)) return [];
    const out: CanvasSkillDef[] = [];
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const files = readSkillFiles(dir);
      const parsed = parseSkillMd(files['SKILL.md'], entry);
      out.push({
        name: entry,
        description: parsed.description,
        kind: 'builtin',
        enabled: true,
        updatedAt: null,
        files,
      });
    }
    return out.sort(bySkillOrder);
  }

  private isBuiltin(name: string): boolean {
    return this.builtins().some((b) => b.name === name);
  }

  /** 内置在前、用户在后，各自按名称——顺序决定清单文本，必须稳定 */
  private async all(userId: string): Promise<CanvasSkillDef[]> {
    const builtins = this.builtins();
    const taken = new Set(builtins.map((b) => b.name));
    const rows = await this.prisma.canvasSkill.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
    const users = rows
      // 与内置同名的行不应存在（save 会拒）；万一有，内置优先，不让用户版本遮蔽内置
      .filter((r) => !taken.has(r.name))
      .map<CanvasSkillDef>((r) => ({
        name: r.name,
        description: r.description,
        kind: 'user',
        enabled: r.enabled,
        updatedAt: r.updatedAt.toISOString(),
        files: { 'SKILL.md': r.content },
      }));
    return [...builtins, ...users].sort(bySkillOrder);
  }

  /** 管理页 / 输入框补全：含停用的（管理页要能重新启用） */
  async listFor(userId: string): Promise<CanvasSkillSummary[]> {
    return (await this.all(userId)).map(({ files: _f, ...rest }) => rest);
  }

  /** 运行时：只要启用的，含文件 */
  async effectiveFor(userId: string): Promise<CanvasSkillDef[]> {
    return (await this.all(userId)).filter((s) => s.enabled);
  }

  async detailFor(
    userId: string,
    name: string,
  ): Promise<CanvasSkillSummary & { files: string[]; content: string }> {
    const def = (await this.all(userId)).find((s) => s.name === name);
    if (!def) {
      throw new BusinessException(
        ErrorCodes.CANVAS_SKILL_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const { files, ...rest } = def;
    return {
      ...rest,
      files: Object.keys(files).sort(),
      content: files['SKILL.md'] ?? '',
    };
  }

  /**
   * 新建或覆盖一个用户技能（save_skill 工具的落点）。校验不过返回错误清单而不是抛异常：
   * 调用方是模型，一句可读的错误它下一步就能改正。
   */
  async save(
    userId: string,
    input: { name: string; description: string; instructions: string },
  ): Promise<SaveSkillResult> {
    const name = input.name.trim();
    const description = input.description.trim();
    const errors = validateSkill({ name, description, dirName: name });
    if (this.isBuiltin(name)) {
      errors.push(`"${name}" 是内置技能，不能覆盖；换一个名称`);
    }
    const length = input.instructions.trim().length;
    if (length === 0) errors.push('instructions（技能正文）不能为空');
    if (length > MAX_INSTRUCTIONS_CHARS) {
      errors.push(
        `instructions 太长（${length} 字 > ${MAX_INSTRUCTIONS_CHARS}）：只写这个任务特有的步骤与提示词模板，删掉通用规则和重复内容`,
      );
    }
    if (errors.length > 0) return { ok: false, errors };

    const content = buildSkillMd(name, description, input.instructions);
    const existing = await this.prisma.canvasSkill.findUnique({
      where: { userId_name: { userId, name } },
      select: { id: true },
    });
    const row = await this.prisma.canvasSkill.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, description, content },
      // 覆盖时顺带重新启用：用户让 agent 改它，就是要用它
      update: { description, content, enabled: true },
    });
    return {
      ok: true,
      name,
      created: !existing,
      skill: {
        name,
        description,
        kind: 'user',
        enabled: true,
        updatedAt: row.updatedAt.toISOString(),
        files: { 'SKILL.md': content },
      },
    };
  }

  async setEnabled(userId: string, name: string, enabled: boolean) {
    await this.assertOwned(userId, name);
    await this.prisma.canvasSkill.update({
      where: { userId_name: { userId, name } },
      data: { enabled },
    });
    return { name, enabled };
  }

  async remove(userId: string, name: string) {
    await this.assertOwned(userId, name);
    await this.prisma.canvasSkill.delete({
      where: { userId_name: { userId, name } },
    });
    return { name, deleted: true };
  }

  /** 内置的不能改状态/删除；用户的必须存在 */
  private async assertOwned(userId: string, name: string) {
    if (this.isBuiltin(name)) {
      throw new BusinessException(
        ErrorCodes.CANVAS_SKILL_BUILTIN,
        HttpStatus.FORBIDDEN,
      );
    }
    const row = await this.prisma.canvasSkill.findUnique({
      where: { userId_name: { userId, name } },
      select: { id: true },
    });
    if (!row) {
      throw new BusinessException(
        ErrorCodes.CANVAS_SKILL_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
