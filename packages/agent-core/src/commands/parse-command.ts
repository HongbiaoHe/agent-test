/** 解析以 / 开头的命令输入：`/email-compose 周报` → { name:"email-compose", args:"周报" }。非命令返回 null。 */
export function parseCommand(
  text: string,
): { name: string; args: string } | null {
  const m = text.trimStart().match(/^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1], args: m[2].trim() };
}
