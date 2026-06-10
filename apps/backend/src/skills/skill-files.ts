import type { FileData } from 'deepagents';

/** 虚拟 FS 里单个文件的存储结构（与 deepagents StateBackend FileDataV1 对应）。 */
export interface SkillFile {
  content: string[];
  created_at: string;
  modified_at: string;
}

/**
 * 把 SKILL.md 里指向 skill 内部文件的相对路径改写成绝对路径。
 *
 * deepagents 的 read_file 是按绝对 key 精确查表（StateBackend 无相对路径解析），其虚拟 FS
 * 里 skill 子文件的真实 key 是 `/skills/<name>/<rel>`。但 SKILL.md 正文常写相对路径
 * （`./references/xxx.md`、`references/xxx.md`、或 markdown 链接 `](./sub-skill.md)`），
 * 模型据此调 read_file 会被规整成根目录 `/references/xxx.md`、`/sub-skill.md` → 与真实 key
 * 不匹配 → File not found（已实测复现）。这里统一改写为绝对路径，去掉这个 404 障碍，
 * progressive disclosure 的「按需 read_file 子文件」才真正能命中。
 *
 * 覆盖两类 skill 的引用写法：
 *   - tvc-director：`./references/xxx.md` / 旧写法裸 `references/xxx.md`（强制阶段门）
 *   - marketing-strategist：路由表里的 markdown 链接 `](./sub-skill.md)`（sub-skill 唯一入口）
 * 也对未来的 reference asset（如 `./assets/foo.png`）自动生效。
 *
 * 只改写「定界符（反引号 / markdown 链接 `](`）后紧跟 ./ 或裸 references/」的相对路径：
 *   - `./` 是 skill 内相对引用的通用信号，改写后绝对路径精确命中虚拟 FS
 *   - http(s)://、已是 / 开头的绝对路径不以这两种前缀起始，天然不被波及
 *   - frontmatter 的 description 是散文、不含这些 token，解析不受影响
 */
export function absolutizeRefPaths(name: string, skillMd: string): string {
  const base = `/skills/${name}/`;
  return (
    skillMd
      // 反引号 / markdown 链接 `](` 后、以 ./ 开头的 skill 内相对路径 → 绝对路径
      .replace(/(`|\]\()\.\//g, `$1${base}`)
      // 兼容旧写法：反引号里裸写的 references/（无 ./ 前缀）→ 绝对路径
      .replace(/`references\//g, '`' + base + 'references/')
  );
}

/** 文本内容 → StoreBackend 的 FileData 值（content 按行数组 + 时间戳，dist 的 convertStoreItemToFileData 校验这三字段）。 */
export function toFileData(content: string, now: string): FileData {
  return { content: content.split('\n'), created_at: now, modified_at: now };
}
