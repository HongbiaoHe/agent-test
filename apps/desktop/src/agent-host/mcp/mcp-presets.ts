/** 推荐连接器：拷自 apps/backend/src/mcp/mcp-presets.ts（改动两边同步）；URL 可用 env 覆盖。 */
import type { McpPreset } from '../../shared/mcp';

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
