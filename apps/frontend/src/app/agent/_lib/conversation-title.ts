/** 会话显示名：用户重命名的标题优先，没有则回退首条消息（goal），都为空时显示占位。 */
export function conversationTitle(c: { title: string | null; goal: string }): string {
  return c.title?.trim() || c.goal.trim() || "New conversation";
}
