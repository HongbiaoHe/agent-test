import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { decryptJson, encryptJson } from '../mcp/mcp-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { McpGrantService } from './mcp-grant.service';
import {
  AUTH_CODE_TTL_S,
  grantableScopes,
  isMcpScope,
  type McpScope,
  mcpPublicOrigin,
  mcpResourceUrl,
  NEVER_EXPIRES_S,
} from './mcp-server.config';

/** /oauth/authorize 收到、等用户在同意页拍板的那次请求 */
const authRequestSchema = z.object({
  clientId: z.string(),
  clientName: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  state: z.string().optional(),
  scopes: z.array(z.string()),
  resource: z.string().optional(),
});
type AuthRequest = z.infer<typeof authRequestSchema>;

/** 用户点了「允许」后签发的授权码所绑定的一切 */
const authCodeSchema = authRequestSchema.extend({
  userId: z.string(),
  tenantId: z.string(),
});
type AuthCode = z.infer<typeof authCodeSchema>;

const requestKey = (id: string) => `mcp-srv:authreq:${id}`;
const codeKey = (code: string) => `mcp-srv:code:${code}`;

/** 同意页展示用 */
export interface ConsentDetails {
  clientName: string;
  /** redirect_uri 的 host：让用户核对授权码会被送到哪里 */
  redirectHost: string;
  scopes: McpScope[];
}

/** 客户端在 DCR 时自报的名字；没报就用 client_id 前 8 位兜底 */
function clientDisplayName(client: OAuthClientInformationFull): string {
  return (
    client.client_name?.trim() || `MCP 客户端 ${client.client_id.slice(0, 8)}`
  );
}

function redirectWith(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.href;
}

/**
 * 自建 OAuth 授权服务器的实现端（SDK 的 handler 负责协议细节：参数校验、PKCE 比对、错误格式）。
 *
 * 流程：/oauth/authorize → 本类 authorize() 把请求存进 Redis、跳前端同意页 →
 * 用户允许（McpServerController.approve → approve()）→ 带授权码回跳客户端 →
 * /oauth/token 换码（exchangeAuthorizationCode）→ McpGrantService 建授权、发令牌。
 */
@Injectable()
export class McpOAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: McpGrantService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (clientId) => {
      const row = await this.prisma.mcpOAuthClient.findUnique({
        where: { id: clientId },
      });
      if (!row) return undefined;
      const parsed = OAuthClientInformationFullSchema.safeParse({
        ...(typeof row.metadata === 'object' ? row.metadata : {}),
        client_id: row.id,
        client_secret: decryptJson<string>(row.secretEnc),
      });
      return parsed.success ? parsed.data : undefined;
    },
    registerClient: async (client) => {
      const id = randomBytes(16).toString('hex');
      const { client_secret, ...metadata } = client;
      const full: OAuthClientInformationFull = {
        ...metadata,
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(client_secret ? { client_secret } : {}),
      };
      await this.prisma.mcpOAuthClient.create({
        data: {
          id,
          secretEnc: client_secret ? encryptJson(client_secret) : null,
          // 不含 client_id / client_secret：前者是主键，后者另存密文
          metadata: {
            ...metadata,
            client_id_issued_at: full.client_id_issued_at,
          },
        },
      });
      return full;
    },
  };

  /** 存下这次请求，把浏览器送到前端同意页（未登录时前端会先送去登录） */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const id = randomBytes(24).toString('base64url');
    const req: AuthRequest = {
      clientId: client.client_id,
      clientName: clientDisplayName(client),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: grantableScopes(params.scopes ?? []),
      resource: params.resource?.href,
    };
    await this.redis.set(
      requestKey(id),
      JSON.stringify(req),
      'EX',
      AUTH_CODE_TTL_S,
    );
    const consent = new URL('/oauth/consent', mcpPublicOrigin());
    consent.searchParams.set('request', id);
    res.redirect(consent.href);
  }

  // ───────────────────── 同意页（McpServerController 调） ─────────────────────

  async consentDetails(requestId: string): Promise<ConsentDetails> {
    const req = await this.loadRequest(requestId, false);
    return {
      clientName: req.clientName,
      redirectHost: new URL(req.redirectUri).host,
      scopes: req.scopes.filter(isMcpScope),
    };
  }

  /** 允许：签发一次性授权码，返回带 code + state 的回跳地址 */
  async approve(
    requestId: string,
    user: { userId: string; tenantId: string },
  ): Promise<{ redirectUrl: string }> {
    const req = await this.loadRequest(requestId, true);
    const code = randomBytes(32).toString('base64url');
    const payload: AuthCode = { ...req, ...user };
    await this.redis.set(
      codeKey(code),
      JSON.stringify(payload),
      'EX',
      AUTH_CODE_TTL_S,
    );
    return {
      redirectUrl: redirectWith(req.redirectUri, { code, state: req.state }),
    };
  }

  /** 拒绝：按 OAuth 规范带 error=access_denied 回跳 */
  async deny(requestId: string): Promise<{ redirectUrl: string }> {
    const req = await this.loadRequest(requestId, true);
    return {
      redirectUrl: redirectWith(req.redirectUri, {
        error: 'access_denied',
        error_description: '用户拒绝了授权',
        state: req.state,
      }),
    };
  }

  // ───────────────────────────── 令牌端点 ─────────────────────────────

  /** PKCE 比对前取 challenge：只读不消费（消费在 exchangeAuthorizationCode） */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const raw = await this.redis.get(codeKey(authorizationCode));
    const code = raw ? parseJson(authCodeSchema, raw) : null;
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError('授权码无效或已过期');
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // GETDEL：授权码只能用一次，并发换码只有一个拿得到
    const raw = await this.redis.getdel(codeKey(authorizationCode));
    const code = raw ? parseJson(authCodeSchema, raw) : null;
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError('授权码无效、已过期或已使用');
    }
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri 与授权请求不一致');
    }
    if (resource && code.resource && resource.href !== code.resource) {
      throw new InvalidGrantError('resource 与授权请求不一致');
    }
    return this.grants.issueOAuth(
      { userId: code.userId, tenantId: code.tenantId },
      { clientId: client.client_id, name: code.clientName },
      code.scopes.filter(isMcpScope),
    );
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    return this.grants.rotateRefresh(client.client_id, refreshToken, scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = await this.grants.verify(token);
    if (!p) throw new InvalidTokenError('令牌无效、已过期或已吊销');
    return {
      token,
      clientId: p.clientId ?? 'pat',
      scopes: p.scopes,
      expiresAt: p.expiresAt ?? NEVER_EXPIRES_S,
      resource: mcpResourceUrl(),
    };
  }

  revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    return this.grants.revokeByToken(client.client_id, request.token);
  }

  /** consume=true 时取完即删：一次授权请求只能拍板一次 */
  private async loadRequest(
    id: string,
    consume: boolean,
  ): Promise<AuthRequest> {
    const raw = consume
      ? await this.redis.getdel(requestKey(id))
      : await this.redis.get(requestKey(id));
    const req = raw ? parseJson(authRequestSchema, raw) : null;
    if (!req) {
      throw new BusinessException(
        ErrorCodes.MCP_CONSENT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return req;
  }
}

/** Redis 里是我们自己写进去的 JSON，仍按 schema 解析（版本变更 / 脏数据时当作不存在） */
function parseJson<S extends z.ZodType>(
  schema: S,
  raw: string,
): z.infer<S> | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
