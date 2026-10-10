/**
 * 输入框里的 `/技能名`。名称规则与后端 skill-context.parseSlashCommand 一致
 * （Agent Skills 规范：小写字母/数字/连字符，首尾为字母或数字，≤64）。
 */

/** 正在敲命令名（以 / 开头、还没有空白）→ 返回已敲的部分（可为空串）；否则 null */
export function slashQuery(draft: string): string | null {
  const m = /^\/([a-z0-9-]*)$/.exec(draft);
  return m ? m[1] : null;
}

/** 文本开头的 `/技能名`（后面跟空白或结束）；不是则 null */
export function leadingSkill(
  text: string,
): { name: string; rest: string } | null {
  const m = /^\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s+([\s\S]*))?$/.exec(
    text.trimStart(),
  );
  return m ? { name: m[1], rest: m[2] ?? "" } : null;
}

/** 把草稿开头的命令换成 `/name `（已有别的命令就替换掉，保留后面的正文） */
export function withSkill(draft: string, name: string): string {
  const cur = leadingSkill(draft);
  const rest = cur ? cur.rest : slashQuery(draft) !== null ? "" : draft;
  return `/${name} ${rest.trimStart()}`;
}

/** 去掉草稿开头的命令，只留正文 */
export function withoutSkill(draft: string): string {
  const cur = leadingSkill(draft);
  return cur ? cur.rest : draft;
}
