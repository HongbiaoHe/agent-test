/**
 * 校验「登录后回跳到哪」的 next 参数。middleware 与登录页共用同一份判据。
 *
 * 只接受站内绝对路径：
 * - `//evil.com` 与 `/\evil.com` 会被浏览器当协议相对 URL 解析 → 开放重定向，必须挡掉；
 * - 回到 /login 会形成死循环（登录成功后又被送回登录页）。
 *
 * 返回 null = 不可用，调用方自行退回缺省目的地。
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) {
    return null;
  }
  return raw;
}
