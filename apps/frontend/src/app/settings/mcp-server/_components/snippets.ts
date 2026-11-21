/** 各客户端的接入片段：OAuth（客户端自己走授权）与 PAT（令牌写进请求头）两种 */

const SERVER_NAME = "canvas";

export function claudeCodeCommand(url: string, token?: string): string {
  const base = `claude mcp add --transport http ${SERVER_NAME} ${url}`;
  return token ? `${base} \\\n  --header "Authorization: Bearer ${token}"` : base;
}

export function mcpJson(url: string, token?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          type: "http",
          url,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      },
    },
    null,
    2,
  );
}
