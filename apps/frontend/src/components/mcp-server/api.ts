import { request } from "@/lib/api";

/**
 * 画布 MCP 对外服务（第三方 agent 经 MCP 操作画布）的站内接口：设置页与 OAuth 同意页共用。
 * 后端见 apps/backend/src/mcp-server/mcp-server.controller.ts。
 */

export type McpScope = "canvas:read" | "canvas:write" | "media:generate";

export const SCOPE_INFO: Record<McpScope, { label: string; description: string }> = {
  "canvas:read": {
    label: "Read canvases",
    description: "List your canvases and read nodes, links and generation results",
  },
  "canvas:write": {
    label: "Edit canvases",
    description: "Create canvases, add / edit / delete nodes and links, import media",
  },
  "media:generate": {
    label: "Generate media",
    description: "Start image / video generations and merges — this uses your credits",
  },
};

export const ALL_SCOPES = Object.keys(SCOPE_INFO) as McpScope[];

export function isScope(v: string): v is McpScope {
  return v in SCOPE_INFO;
}

export interface McpGrant {
  id: string;
  kind: "oauth" | "pat";
  name: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** 最近在用它的 agent（MCP initialize 自报的名字，如 “Claude Code”）；不知道为 null */
  agent: string | null;
}

export interface McpServerInfo {
  mcpUrl: string;
  scopes: McpScope[];
}

export interface ConsentDetails {
  clientName: string;
  redirectHost: string;
  scopes: McpScope[];
}

export const MCP_GRANTS_KEY = ["mcp-server", "grants"] as const;
export const MCP_SERVER_INFO_KEY = ["mcp-server", "info"] as const;

export const getMcpServerInfo = () => request<McpServerInfo>("/mcp-server/info");

export const listMcpGrants = () => request<McpGrant[]>("/mcp-server/grants");

export const createMcpToken = (body: {
  name: string;
  scopes: McpScope[];
  expiresInDays?: number;
}) =>
  request<{ grant: McpGrant; token: string }>("/mcp-server/grants", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const revokeMcpGrant = (id: string) =>
  request<{ revoked: true }>(`/mcp-server/grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const getConsent = (requestId: string) =>
  request<ConsentDetails>(`/mcp-server/consent/${encodeURIComponent(requestId)}`);

export const decideConsent = (requestId: string, decision: "approve" | "deny") =>
  request<{ redirectUrl: string }>(
    `/mcp-server/consent/${encodeURIComponent(requestId)}/${decision}`,
    { method: "POST" },
  );
