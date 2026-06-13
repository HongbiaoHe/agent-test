/** 技能 frontmatter 解析与合法性校验。纯函数，无 I/O，方便测试与跨层复用。 */

/** parseSkillMd 的返回结构；只含 frontmatter 里实际存在的可选字段。 */
export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
}

/**
 * 解析 SKILL.md 原始文本：提取 frontmatter 中的 name/description 以及可选字段，
 * 并返回 frontmatter 之后的正文。
 *
 * - 正则复用 command-registry.service.ts:46 的 frontmatter 模式，保持一致性。
 * - 只向返回值注入 frontmatter 中确实存在的可选字段（key 缺失时不设 undefined 属性），
 *   以确保 toEqual 断言在不含可选字段的预期对象上也能通过。
 * - `metadata.entrypoint` 有意不解析（设计裁决，见 Task 2 说明）。
 */
export function parseSkillMd(raw: string, fallbackName: string): ParsedSkill {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: '', body: raw.trim() };

  const fm = m[1];
  const body = m[2].trim();

  /** 从 frontmatter 块取单行值，去除首尾引号。*/
  const get = (k: string): string => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  const result: ParsedSkill = {
    name: get('name') || fallbackName,
    description: get('description'),
    body,
  };

  // 只在 frontmatter 中实际存在时才附加可选字段
  const license = get('license');
  if (license) result.license = license;

  const compatibility = get('compatibility');
  if (compatibility) result.compatibility = compatibility;

  const allowedTools = get('allowed-tools');
  if (allowedTools) result.allowedTools = allowedTools;

  return result;
}

/**
 * 校验技能元数据，返回错误描述数组（空数组 = 合法）。
 *
 * 规则：
 * - name 匹配 /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/ 且 ≤64 字符
 * - name 必须与目录名一致（防止 frontmatter 填错）
 * - description 非空且 ≤1024
 * - compatibility 若存在则 ≤500
 */
export function validateSkill(s: {
  name: string;
  description: string;
  dirName: string;
  compatibility?: string;
}): string[] {
  const errors: string[] = [];

  const nameRe = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  if (!nameRe.test(s.name)) {
    errors.push(
      `name "${s.name}" 不合法：只允许小写字母、数字、连字符，且首尾须为字母或数字，总长 ≤64`,
    );
  }

  if (s.name !== s.dirName) {
    errors.push(`name "${s.name}" 与目录名 "${s.dirName}" 不一致`);
  }

  if (!s.description) {
    errors.push('description 必填');
  } else if (s.description.length > 1024) {
    errors.push(`description 超长（${s.description.length} > 1024）`);
  }

  if (s.compatibility !== undefined && s.compatibility.length > 500) {
    errors.push(`compatibility 超长（${s.compatibility.length} > 500）`);
  }

  return errors;
}
