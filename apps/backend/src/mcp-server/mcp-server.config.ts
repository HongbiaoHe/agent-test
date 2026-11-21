import { hostOrigins } from '../mcp/mcp-sandbox';

/**
 * 画布 MCP 对外服务的常量与地址（设计见 docs/superpowers/specs/2026-11-21-canvas-mcp-server-design.md）。
 * 与 src/mcp（我方作为 MCP 客户端连外部服务）方向相反，互不依赖。
 */

/** 授权粒度：读画布 / 改画布结构 / 发起会花钱的生成与拼接。 */
export const MCP_SCOPES = [
  'canvas:read',
  'canvas:write',
  'media:generate',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export function isMcpScope(s: string): s is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(s);
}

/**
 * 客户端申请的 scope → 实际授予的：只留认识的；一个都没申请（多数客户端不带 scope）就给全部，
 * 用户在同意页上看得到将授予哪些。
 */
export function grantableScopes(requested: readonly string[]): McpScope[] {
  const known = MCP_SCOPES.filter((s) => requested.includes(s));
  return known.length > 0 ? known : [...MCP_SCOPES];
}

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
/** 授权码与同意页中间态的有效期 */
export const AUTH_CODE_TTL_S = 10 * 60;

/** PAT 可选有效期（天）；null = 永不过期 */
export const PAT_EXPIRY_DAYS = [30, 90, 365] as const;

/** 永不过期的 PAT 对外报的到期时刻：SDK 的 bearer 校验要求有个数字，给一个足够远的 */
export const NEVER_EXPIRES_S = Date.UTC(9999, 0, 1) / 1000;

/** 对外公网 origin（OAuth issuer、MCP 资源地址都基于它）：MCP_PUBLIC_URL，缺省主站地址。 */
export function mcpPublicOrigin(): string {
  const raw = process.env.MCP_PUBLIC_URL ?? hostOrigins()[0];
  return new URL(raw).origin;
}

/** MCP 资源地址（RFC 8707 resource / RFC 9728 resource） */
export function mcpResourceUrl(): URL {
  return new URL('/mcp', mcpPublicOrigin());
}

/** 画布在网页上的地址：第三方 agent 开始操作某块画布时用预览 / 浏览器打开它，让用户实时看到改动 */
export function canvasUrl(canvasId: string): string {
  return new URL(`/canvas/${encodeURIComponent(canvasId)}`, mcpPublicOrigin())
    .href;
}
