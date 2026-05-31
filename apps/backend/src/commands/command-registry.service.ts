import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface CommandDef {
  name: string; // = 目录名 / frontmatter name，作为 /name 调用
  description: string;
  domain: string; // 命名约定 <domain>-<action>，按 domain 分组
  raw: string; // 完整 SKILL.md 内容（= read_file 读到的内容），作为 tool 消息常驻上下文
}

const SKILLS_DIR = process.env.SKILLS_DIR ?? join(process.cwd(), 'skills');

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
    if (!existsSync(SKILLS_DIR)) {
      this.logger.warn(`skills 目录不存在: ${SKILLS_DIR}`);
      return;
    }
    for (const entry of readdirSync(SKILLS_DIR)) {
      const skillPath = join(SKILLS_DIR, entry, 'SKILL.md');
      if (!existsSync(skillPath) || !statSync(join(SKILLS_DIR, entry)).isDirectory()) {
        continue;
      }
      const raw = readFileSync(skillPath, 'utf8');
      const parsed = parseSkill(raw, entry);
      const name = parsed.name;
      this.commands.set(name, {
        name,
        description: parsed.description,
        domain: name.includes('-') ? name.split('-')[0] : 'general',
        raw,
      });
    }
    this.logger.log(`已加载 ${this.commands.size} 个命令: ${[...this.commands.keys()].join(', ')}`);
  }

  /** 前端补全用：name + description + domain（不含正文）。 */
  list(): Omit<CommandDef, 'raw'>[] {
    return [...this.commands.values()].map(({ raw: _raw, ...rest }) => rest);
  }

  /** 全部技能（含完整 raw），worker 注入 SkillsMiddleware 的 state 用。 */
  all(): CommandDef[] {
    return [...this.commands.values()];
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }
}
