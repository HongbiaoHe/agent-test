import { Injectable, Logger } from '@nestjs/common';
import express, { type Request, type Response, Router } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpCanvasService } from './mcp-canvas.service';
import { McpGrantService } from './mcp-grant.service';
import { McpOAuthProvider } from './mcp-oauth.provider';
import {
  MCP_SCOPES,
  mcpPublicOrigin,
  mcpResourceUrl,
} from './mcp-server.config';
import { buildCanvasMcpServer } from './mcp-tools';

/**
 * 限流按真实客户端 IP 计：后端只经 Next rewrites 对外（同机反代），所有请求的 socket 地址都是 Next，
 * 不取 X-Forwarded-For 的话全站共用一个额度。后端不直接对公网暴露，所以这里信任该头。
 */
function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}
const rateLimit = { keyGenerator: clientIp, validate: false };

/**
 * 画布 MCP 对外服务的协议端点（express 层，在 Nest 路由之前挂载，见 main.ts）：
 *
 * - `/.well-known/oauth-authorization-server`、`/.well-known/oauth-protected-resource[/mcp]`：发现元数据
 * - `/oauth/{authorize,token,register,revoke}`：SDK 的标准 handler（参数校验、PKCE、错误格式），
 *   实现端是 McpOAuthProvider。挂 /oauth/ 前缀而不是 SDK 默认的根路径，免得和前端页面路由撞
 * - `POST /mcp`：无状态 Streamable HTTP（纯 JSON 响应），每个请求按令牌 scope 现装一个 McpServer
 *
 * 这些路由不经 Nest 的 guard / 拦截器 / 异常过滤器，响应格式完全由协议决定。
 */
@Injectable()
export class McpServerHttp {
  private readonly logger = new Logger(McpServerHttp.name);
  readonly router: Router;

  constructor(
    private readonly provider: McpOAuthProvider,
    private readonly grants: McpGrantService,
    private readonly canvas: McpCanvasService,
  ) {
    this.router = this.build();
  }

  private build(): Router {
    const origin = mcpPublicOrigin();
    const at = (path: string) => new URL(path, origin).href;
    const oauthMetadata: OAuthMetadata = {
      ...createOAuthMetadata({
        provider: this.provider,
        issuerUrl: new URL(origin),
      }),
      // RFC 8414：issuer 必须与资源元数据 authorization_servers 里的写法逐字一致（URL.href 会补尾斜杠）
      issuer: origin,
      authorization_endpoint: at('/oauth/authorize'),
      token_endpoint: at('/oauth/token'),
      registration_endpoint: at('/oauth/register'),
      revocation_endpoint: at('/oauth/revoke'),
      scopes_supported: [...MCP_SCOPES],
    };
    const resourceMetadata: OAuthProtectedResourceMetadata = {
      resource: mcpResourceUrl().href,
      authorization_servers: [origin],
      scopes_supported: [...MCP_SCOPES],
      resource_name: 'AgentSpark Canvas',
    };

    const r = Router();
    r.use(
      '/.well-known/oauth-authorization-server',
      metadataHandler(oauthMetadata),
    );
    // RFC 9728 按资源路径挂；部分客户端只查根路径，两处都给
    r.use(
      '/.well-known/oauth-protected-resource/mcp',
      metadataHandler(resourceMetadata),
    );
    r.use(
      '/.well-known/oauth-protected-resource',
      metadataHandler(resourceMetadata),
    );
    r.use(
      '/oauth/authorize',
      authorizationHandler({ provider: this.provider, rateLimit }),
    );
    r.use('/oauth/token', tokenHandler({ provider: this.provider, rateLimit }));
    r.use(
      '/oauth/register',
      clientRegistrationHandler({
        clientsStore: this.provider.clientsStore,
        rateLimit,
      }),
    );
    r.use(
      '/oauth/revoke',
      revocationHandler({ provider: this.provider, rateLimit }),
    );

    r.post('/mcp', express.json({ limit: '1mb' }), (req, res) => {
      void this.handleMcp(req, res);
    });
    // 无状态：没有 SSE 推送流（GET）也没有会话可删（DELETE）
    r.all('/mcp', (_req, res) => {
      res
        .status(405)
        .set('Allow', 'POST')
        .json(rpcError(-32000, 'Method not allowed'));
    });
    return r;
  }

  private async handleMcp(req: Request, res: Response): Promise<void> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const verified = m ? await this.grants.verify(m[1]) : null;
    if (!verified) {
      // 401 + resource_metadata：MCP 客户端据此发现授权服务器、走 OAuth。
      // 响应头只能是 latin1，描述用英文
      const desc = m
        ? 'Token is invalid, expired or revoked'
        : 'Missing Bearer token';
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          `Bearer error="invalid_token", error_description="${desc}", resource_metadata="${getOAuthProtectedResourceMetadataUrl(mcpResourceUrl())}"`,
        )
        .json({ error: 'invalid_token', error_description: desc });
      return;
    }
    // 认出是哪个 agent（画布上的「xx is editing」提示要用）
    const principal = {
      ...verified,
      agent: await this.grants.agentOf(verified, req.body),
    };
    const server = buildCanvasMcpServer(this.canvas, principal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      this.logger.error(
        `MCP 请求处理失败：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, 'Internal server error'));
      }
    }
  }
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
