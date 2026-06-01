import type { CommandDef } from '../commands/command-registry.service';

export interface SkillFile {
  content: string[];
  created_at: string;
  modified_at: string;
}

/**
 * 把技能目录铺成 deepagents StateBackend 的文件表：键为 `/skills/<name>/<相对路径>`。
 * 注入整棵目录（SKILL.md + references/** 等子文件），否则 SKILL.md 里
 * `read_file references/*.md` 的指示会因文件缺失而失败。
 */
export function buildSkillFiles(
  defs: CommandDef[],
  now: string,
): Record<string, SkillFile> {
  const files: Record<string, SkillFile> = {};
  for (const def of defs) {
    for (const [rel, content] of Object.entries(def.files)) {
      files[`/skills/${def.name}/${rel}`] = {
        content: content.split('\n'),
        created_at: now,
        modified_at: now,
      };
    }
  }
  return files;
}
