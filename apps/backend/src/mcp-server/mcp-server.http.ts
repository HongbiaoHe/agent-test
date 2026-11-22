import { Injectable, Logger } from '@nestjs/common';
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  Router,
} from 'express';
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
import { InflightCalls } from './mcp-inflight';
import { McpOAuthProvider } from './mcp-oauth.provider';
import {
  MCP_SCOPES,
  mcpPublicOrigin,
  mcpResourceUrl,
} from './mcp-server.config';
import { buildCanvasMcpServer } from './mcp-tools';
import { z } from 'zod';

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
  /** 在途的 tools/call：客户端发来取消通知时据此中止原调用（见 InflightCalls） */
  private readonly inflight = new InflightCalls();

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
    // 请求体超限：body-parser 抛 entity.too.large，不接住会落到全局过滤器变成 500「System is busy」
    r.use('/mcp', ((err, _req, res, next) => {
      if (isBodyTooLarge(err)) {
        res
          .status(413)
          .json(rpcError(-32600, 'Request body too large (limit 1MB)'));
        return;
      }
      next(err);
    }) satisfies ErrorRequestHandler);
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
    const keyOf = (id: RequestId) =>
      `${verified.grantId}|${clientIp(req)}|${String(id)}`;
    for (const id of cancelledIds(req.body)) this.inflight.cancel(keyOf(id));
    const abort = new AbortController();
    const calls = toolCallIds(req.body).map(keyOf);
    this.inflight.register(calls, abort);

    const server = buildCanvasMcpServer(this.canvas, principal, abort.signal);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      // 连接断了（客户端中止 / 反代超时）同样停掉还在跑的工具
      abort.abort();
      this.inflight.release(calls, abort);
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

const requestId = z.union([z.string(), z.number()]);
type RequestId = z.infer<typeof requestId>;
const toolCall = z.object({ method: z.literal('tools/call'), id: requestId });
const cancelled = z.object({
  method: z.literal('notifications/cancelled'),
  params: z.object({ requestId }),
});

/** JSON-RPC 请求体（单条或批量）里每条消息 */
function messagesOf(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

/** 这次请求里 tools/call 的 id */
function toolCallIds(body: unknown): RequestId[] {
  return messagesOf(body).flatMap((m) => {
    const r = toolCall.safeParse(m);
    return r.success ? [r.data.id] : [];
  });
}

/** 这次请求里 notifications/cancelled 要取消的请求 id */
function cancelledIds(body: unknown): RequestId[] {
  return messagesOf(body).flatMap((m) => {
    const r = cancelled.safeParse(m);
    return r.success ? [r.data.params.requestId] : [];
  });
}

function isBodyTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    err.type === 'entity.too.large'
  );
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
