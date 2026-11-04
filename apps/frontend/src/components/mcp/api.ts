import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { request } from "@/lib/api";

/** 工具权限：允许 / 需审批 / 禁用（后端 mcp-types.ts 同名类型）。 */
export type ToolPermission = "allow" | "ask" | "deny";
export type ToolVisibility = "model" | "app";
export type McpServerStatus = "disconnected" | "connected" | "needs_auth" | "error";

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
  | { status: "connected"; server: McpServer }
  | { status: "needs_auth"; server: McpServer; authorizationUrl: string }
  | { status: "error"; server: McpServer; error: string };

/** MCP App 卡片数据：随 tool_end 落库（后端 McpAppArtifact）。 */
export interface McpAppArtifact {
  serverId: string;
  serverName: string;
  toolName: string;
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
}

export interface McpAuthRequired {
  serverId: string;
  serverName: string;
}

export interface McpAppResource {
  html: string;
  mimeType: string | null;
  meta: { ui?: McpUiResourceMeta } | null;
  sandboxOrigin: string;
  serverName: string;
  tools: { name: string; title?: string; visibility: ToolVisibility[]; permission: ToolPermission }[];
}

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

export const MCP_SERVERS_KEY = ["mcp-servers"] as const;
export const mcpServerKey = (id: string) => ["mcp-server", id] as const;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export function listMcpServers(): Promise<{ servers: McpServer[]; presets: McpPreset[] }> {
  return request("/mcp/servers");
}

export function getMcpServer(id: string): Promise<McpServer> {
  return request(`/mcp/servers/${encodeURIComponent(id)}`);
}

export function createMcpServer(input: { url: string; name?: string }): Promise<ConnectResult> {
  return request("/mcp/servers", json(input));
}

export function connectMcpPreset(key: string): Promise<ConnectResult> {
  return request(`/mcp/presets/${encodeURIComponent(key)}`, { method: "POST" });
}

export function connectMcpServer(id: string): Promise<ConnectResult> {
  return request(`/mcp/servers/${encodeURIComponent(id)}/connect`, { method: "POST" });
}

export function disconnectMcpServer(id: string): Promise<McpServer> {
  return request(`/mcp/servers/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
}

export function updateMcpServer(
  id: string,
  patch: { enabled?: boolean; toolPermissions?: Record<string, ToolPermission> },
): Promise<McpServer> {
  return request(`/mcp/servers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteMcpServer(id: string): Promise<{ deleted: true }> {
  return request(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchMcpAppResource(serverId: string, uri: string): Promise<McpAppResource> {
  return request("/mcp/apps/resource", json({ serverId, uri }));
}

export function mcpAppReadResource(serverId: string, uri: string): Promise<ReadResourceResult> {
  return request("/mcp/apps/read-resource", json({ serverId, uri }));
}

export function mcpAppCallTool(input: {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
  confirmed?: boolean;
}): Promise<CallToolResult> {
  return request("/mcp/apps/call-tool", json(input));
}

export function mcpAppSetModelContext(input: {
  serverId: string;
  conversationId: string;
  toolCallId: string;
  text: string;
}): Promise<{ ok: true }> {
  return request("/mcp/apps/model-context", json(input));
}
