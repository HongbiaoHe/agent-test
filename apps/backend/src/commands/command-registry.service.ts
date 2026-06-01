import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface CommandDef {
  name: string; // = 目录名 / frontmatter name，作为 /name 调用
  description: string;
  domain: string; // 命名约定 <domain>-<action>，按 domain 分组
  raw: string; // 完整 SKILL.md 内容（= read_file 读到的内容），作为 tool 消息常驻上下文
  /**
   * 技能目录下的全部文本文件，键为相对路径（如 `SKILL.md`、`references/treatment.md`）。
   * worker 据此把整棵目录注入 StateBackend，agent 才能按 SKILL.md 指示按需 read_file
   * 读取 references/** 等子文件（progressive disclosure 的完整形态）。
   */
  files: Record<string, string>;
}

const skillsDir = () => process.env.SKILLS_DIR ?? join(process.cwd(), 'skills');

// 单文件大小上限，超出（多半是二进制资产）跳过，避免注入垃圾内容撑大 state。
const MAX_SKILL_FILE_BYTES = 512 * 1024;

/** 递归读取技能目录下全部文本文件，返回 相对路径(用 / 分隔) → 内容。跳过 .git 与超大文件。 */
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

/** 解析 SKILL.md：取 frontmatter 的 name/description + 正文。 */
function parseSkill(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: '', body: raw.trim() };
  const fm = m[1];
  const body = m[2].trim();
  const get = (k: string) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return {
    name: get('name') || fallbackName,
    description: get('description'),
    body,
  };
}

/**
 * 命令注册表：启动时扫描 skills/ 目录的 <name>/SKILL.md，
 * 供前端 `/` 自动补全（list）与运行时按名取技能正文（get）。
 * 数据驱动：放一个新的 SKILL.md 即新增一条命令，无需改核心代码。
 */
@Injectable()
export class CommandRegistryService implements OnModuleInit {
  private readonly logger = new Logger(CommandRegistryService.name);
  private commands = new Map<string, CommandDef>();

  onModuleInit() {
    this.load();
  }

  load() {
    this.commands.clear();
    const dir = skillsDir();
    if (!existsSync(dir)) {
      this.logger.warn(`skills 目录不存在: ${dir}`);
      return;
    }
    for (const entry of readdirSync(dir)) {
      const entryDir = join(dir, entry);
      const skillPath = join(entryDir, 'SKILL.md');
      if (!existsSync(skillPath) || !statSync(entryDir).isDirectory()) {
        continue;
      }
      const files = readSkillFiles(entryDir);
      const raw = files['SKILL.md'] ?? readFileSync(skillPath, 'utf8');
      const parsed = parseSkill(raw, entry);
      const name = parsed.name;
      this.commands.set(name, {
        name,
        description: parsed.description,
        domain: name.includes('-') ? name.split('-')[0] : 'general',
        raw,
        files,
      });
    }
    this.logger.log(`已加载 ${this.commands.size} 个命令: ${[...this.commands.keys()].join(', ')}`);
  }

  /** 前端补全用：name + description + domain（不含正文/文件）。 */
  list(): Omit<CommandDef, 'raw' | 'files'>[] {
    return [...this.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
      domain: c.domain,
    }));
  }

  /** 全部技能（含完整 raw），worker 注入 SkillsMiddleware 的 state 用。 */
  all(): CommandDef[] {
    return [...this.commands.values()];
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }
}
