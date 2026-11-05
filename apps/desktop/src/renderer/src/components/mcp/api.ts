/**
 * MCP 连接器与 MCP App 的数据接口（桌面端版 Web components/mcp/api.ts：同名同形，改走 agent-host RPC）。
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { agent } from "@/lib/agent-client";

import type { ToolPermission } from "../../../../shared/mcp";

export type {
  ConnectResult,
  McpAppResource,
  McpPreset,
  McpServer,
  McpServerInfo,
  McpServerStatus,
  McpTool,
  McpUiResourceMeta,
  ToolPermission,
  ToolVisibility,
} from "../../../../shared/mcp";

/** MCP App 卡片数据：随 tool_end 落库（agent-core McpAppArtifact） */
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

export const MCP_SERVERS_KEY = ["mcp-servers"] as const;
export const mcpServerKey = (id: string) => ["mcp-server", id] as const;

export const listMcpServers = () => agent.call("mcp.list", {});

export async function getMcpServer(id: string) {
  const { servers } = await agent.call("mcp.list", {});
  const s = servers.find((x) => x.id === id);
  if (!s) throw new Error("Connector not found");
  return s;
}

export const createMcpServer = (input: { url: string; name?: string }) =>
  agent.call("mcp.add", input);

export const connectMcpPreset = (key: string) => agent.call("mcp.addPreset", { key });

export const connectMcpServer = (id: string) => agent.call("mcp.connect", { id });

export const disconnectMcpServer = (id: string) => agent.call("mcp.disconnect", { id });

export const updateMcpServer = (
  id: string,
  patch: { enabled?: boolean; toolPermissions?: Record<string, ToolPermission> },
) => agent.call("mcp.update", { id, ...patch });

export const deleteMcpServer = (id: string) => agent.call("mcp.remove", { id });

export const fetchMcpAppResource = (serverId: string, uri: string) =>
  agent.call("mcp.appResource", { serverId, uri });

export const mcpAppReadResource = (serverId: string, uri: string) =>
  agent.call("mcp.readResource", { serverId, uri });

export const mcpAppCallTool = (input: {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
  confirmed?: boolean;
}) => agent.call("mcp.callToolFromApp", input);

export const mcpAppSetModelContext = (input: {
  serverId: string;
  conversationId: string;
  toolCallId: string;
  text: string;
}) => agent.call("mcp.setAppContext", input);
