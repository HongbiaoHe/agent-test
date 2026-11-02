/**
 * 推荐连接器（设计 Q11）：设置页「推荐」区块里一键连接的 server。
 * 加新的推荐连接器只要往数组里加一项；URL 走 env，dev / prod 各自配置。
 */
export interface McpPreset {
  key: string;
  name: string;
  description: string;
  url: string;
  iconUrl?: string;
}

export function mcpPresets(): McpPreset[] {
  return [
    {
      key: 'buzzvideo',
      name: 'BuzzVideo',
      description:
        'Generate ad images, videos and voiceovers with interactive result cards.',
      url: process.env.MCP_BUZZVIDEO_URL ?? 'https://dev-api.buzzvideo.ai/mcp',
      iconUrl: 'https://dev-app.buzzvideo.ai/images/logo-icon-180.png',
    },
  ];
}
