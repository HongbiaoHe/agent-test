/**
 * MCP 连接器的视图类型（agent-host → renderer），与 Web 前端 components/mcp/api.ts 同形，
 * 拷来的 Web 连接器 UI / App 卡片可以原样使用。时间字段为 ISO 字符串（同 Web 的 JSON 口径）。
 */
export type ToolPermission = 'allow' | 'ask' | 'deny';
export type ToolVisibility = 'model' | 'app';
export type McpServerStatus = 'disconnected' | 'connected' | 'needs_auth' | 'error';

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  modelSchema: Record<string, unknown> | null;
  incompatibleReason?: string;
  readOnly: boolean;
  destructive: boolean;
  uiResourceUri?: string;
  visibility: ToolVisibility[];
  permission: ToolPermission;
}

export interface McpServerInfo {
  name: string;
  title?: string;
  version?: string;
  websiteUrl?: string;
  description?: string;
  iconUrl?: string;
}

export interface McpServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  presetKey: string | null;
  enabled: boolean;
  status: McpServerStatus;
  lastError: string | null;
  authType: string;
  serverInfo: McpServerInfo | null;
  tools: McpTool[];
  toolsRefreshedAt: string | null;
}

export interface McpPreset {
  key: string;
  name: string;
  description: string;
  url: string;
  iconUrl?: string;
}

export type ConnectResult =
  | { status: 'connected'; server: McpServer }
  | { status: 'needs_auth'; server: McpServer; authorizationUrl: string }
  | { status: 'error'; server: McpServer; error: string };

export interface McpUiResourceMeta {
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: object;
    microphone?: object;
    geolocation?: object;
    clipboardWrite?: object;
  };
  prefersBorder?: boolean;
}

/** App 卡片需要的东西：UI 资源 + 该 server 的 sandbox 源 + 工具快照（审批判断用） */
export interface McpAppResource {
  html: string;
  mimeType: string | null;
  meta: { ui?: McpUiResourceMeta } | null;
  sandboxOrigin: string;
  serverName: string;
  tools: { name: string; title?: string; visibility: ToolVisibility[]; permission: ToolPermission }[];
}

/** 自定义协议：每个连接器一个源 spark-mcp://m-<hash>（main 进程提供代理页，见 main/mcp-sandbox.ts） */
export const MCP_SANDBOX_SCHEME = 'spark-mcp';
