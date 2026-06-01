import type { CommandDef } from '../commands/command-registry.service';

export interface SkillFile {
  content: string[];
  created_at: string;
  modified_at: string;
}

/**
 * 把 SKILL.md 里反引号包裹的相对 reference 路径改写成绝对路径。
 *
 * deepagents 的 read_file 是按绝对 key 精确查表（StateBackend 无相对路径解析），其虚拟 FS
 * 里 reference 的真实 key 是 `/skills/<name>/references/xxx.md`。但 SKILL.md 正文常写成相对
 * 路径 `references/xxx.md`，模型据此调 read_file 会被规整成根目录 `/references/xxx.md` → 与
 * 真实 key 不匹配 → File not found（已实测复现）。这里统一改写为绝对路径，去掉这个 404 障碍。
 *
 * 注意：只改写反引号里的 `references/` 片段，frontmatter 的 description 是散文、不含该 token，
 * 不受影响（避免破坏 SkillsMiddleware 的 frontmatter 解析）。
 */
function absolutizeRefPaths(name: string, skillMd: string): string {
  return skillMd.replace(/`references\//g, '`' + `/skills/${name}/references/`);
}

/**
 * 把技能目录铺成 deepagents StateBackend 的文件表：键为 `/skills/<name>/<相对路径>`。
 * 注入整棵目录（SKILL.md + references/** 等子文件），否则 SKILL.md 里
 * `read_file references/*.md` 的指示会因文件缺失而失败。
 * SKILL.md 额外把相对 reference 路径改写成绝对路径（见 absolutizeRefPaths），
 * 让 SKILL.md 里的「按需 read_file references」指示能真正命中文件。
 */
export function buildSkillFiles(
  defs: CommandDef[],
  now: string,
): Record<string, SkillFile> {
  const files: Record<string, SkillFile> = {};
  for (const def of defs) {
    for (const [rel, content] of Object.entries(def.files)) {
      const injected =
        rel === 'SKILL.md' ? absolutizeRefPaths(def.name, content) : content;
      files[`/skills/${def.name}/${rel}`] = {
        content: injected.split('\n'),
        created_at: now,
        modified_at: now,
      };
    }
  }
  return files;
}
