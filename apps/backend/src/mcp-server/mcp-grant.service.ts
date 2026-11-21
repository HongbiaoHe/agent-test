import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { z } from 'zod';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  ACCESS_TOKEN_TTL_S,
  isMcpScope,
  type McpScope,
  REFRESH_TOKEN_TTL_S,
} from './mcp-server.config';

/** 令牌前缀：一眼认得出是哪种令牌，泄露扫描也好匹配 */
const PREFIX = {
  access: 'cvs_at',
  refresh: 'cvs_rt',
  pat: 'cvs_pat',
} as const;
type TokenKind = keyof typeof PREFIX;

/** 只存哈希：库被拖走也拿不到可用令牌 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}_${randomBytes(32).toString('base64url')}`;
}

const secondsFromNow = (s: number) => new Date(Date.now() + s * 1000);

/** McpGrant.scopes 是 Json 列：读出来按 string[] 收窄并丢掉不认识的 */
const scopesSchema = z.array(z.string());
function parseScopes(json: unknown): McpScope[] {
  const r = scopesSchema.safeParse(json);
  return r.success ? r.data.filter(isMcpScope) : [];
}

/** 一条授权的对外形状（「已授权应用」列表一行） */
export interface McpGrantDto {
  id: string;
  kind: 'oauth' | 'pat';
  name: string;
  scopes: McpScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** 最近在用它的 agent（Claude Code / Cursor…），同 McpGrantService.agentOf；不知道为 null */
  agent: string | null;
}

/** 通过校验的访问令牌所代表的身份 */
export interface McpPrincipal {
  grantId: string;
  userId: string;
  tenantId: string;
  /** 授权的展示名：OAuth 是客户端 DCR 注册名，PAT 是用户起的名字 */
  name: string;
  clientId: string | null;
  /** 是哪个 agent 在用（Claude Code / Codex / Cursor…），见 McpGrantService.agentOf；不知道为 null */
  agent: string | null;
  scopes: McpScope[];
  /** 令牌到期（秒）；永不过期为 null */
  expiresAt: number | null;
}

/** MCP initialize 请求里客户端自报的身份（规范里的 clientInfo：name 必有，title 是给人看的名字） */
const initializeSchema = z.object({
  method: z.literal('initialize'),
  params: z.object({
    clientInfo: z.object({
      name: z.string().min(1).max(200),
      title: z.string().max(200).optional(),
    }),
  }),
});
const CLIENT_INFO_TTL_S = 30 * 24 * 60 * 60;
const clientKey = (grantId: string) => `mcp-srv:client:${grantId}`;

/** lastUsedAt 不必每个请求都写：一分钟内用过就不再更新 */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * 授权与令牌：PAT 与 OAuth 共用一套表（McpGrant + McpToken），校验走同一个入口。
 * 吊销 = 把 grant 标记 revokedAt，其下所有令牌立即失效。
 */
@Injectable()
export class McpGrantService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ───────────────────────────── PAT ─────────────────────────────

  async createPat(
    user: { userId: string; tenantId: string },
    name: string,
    scopes: McpScope[],
    expiresInDays: number | null,
  ): Promise<{ grant: McpGrantDto; token: string }> {
    const token = newToken('pat');
    const expiresAt =
      expiresInDays === null ? null : secondsFromNow(expiresInDays * 86400);
    const grant = await this.prisma.mcpGrant.create({
      data: {
        kind: 'pat',
        userId: user.userId,
        tenantId: user.tenantId,
        name: name.trim().slice(0, 200),
        scopes,
        expiresAt,
        tokens: {
          create: { kind: 'pat', hash: hashToken(token), expiresAt },
        },
      },
    });
    return { grant: toDto(grant), token };
  }

  // ───────────────────────────── 管理 ─────────────────────────────

  /** 未吊销的授权（过期的也列出来，标着到期时间，方便用户清理） */
  async list(userId: string): Promise<McpGrantDto[]> {
    const rows = await this.prisma.mcpGrant.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return [];
    // 列表也显示是哪个 agent 在用（logo）：取 initialize 时记下的 clientInfo，规则同 agentOf
    const remembered = await this.redis.mget(rows.map((g) => clientKey(g.id)));
    return rows.map((g, i) =>
      toDto(g, remembered[i] ?? (g.kind === 'oauth' ? g.name : null)),
    );
  }

  async revoke(userId: string, grantId: string): Promise<{ revoked: true }> {
    const r = await this.prisma.mcpGrant.updateMany({
      where: { id: grantId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (r.count === 0) {
      throw new BusinessException(
        ErrorCodes.MCP_GRANT_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return { revoked: true };
  }

  // ───────────────────────────── OAuth ─────────────────────────────

  /** 同意页点「允许」并换码后：建一条 OAuth 授权，发 access + refresh */
  async issueOAuth(
    user: { userId: string; tenantId: string },
    client: { clientId: string; name: string },
    scopes: McpScope[],
  ): Promise<OAuthTokens> {
    const grant = await this.prisma.mcpGrant.create({
      data: {
        kind: 'oauth',
        userId: user.userId,
        tenantId: user.tenantId,
        name: client.name.slice(0, 200),
        clientId: client.clientId,
        scopes,
      },
    });
    return this.issuePair(grant.id, scopes);
  }

  /**
   * refresh 轮换：旧 refresh 当场作废（删行），发一对新的，scope 沿用原授权。
   * 客户端申请超出原授权的 scope → 拒绝（RFC 6749 §6）；申请更小的范围不单独收窄，
   * 返回的 scope 字段如实给出实际授予的。
   */
  async rotateRefresh(
    clientId: string,
    raw: string,
    requested: string[] | undefined,
  ): Promise<OAuthTokens> {
    const row = await this.prisma.mcpToken.findUnique({
      where: { hash: hashToken(raw) },
      include: { grant: true },
    });
    if (
      !row ||
      row.kind !== 'refresh' ||
      row.grant.clientId !== clientId ||
      row.grant.revokedAt ||
      (row.expiresAt && row.expiresAt <= new Date())
    ) {
      throw new InvalidGrantError('refresh token 无效、已过期或已吊销');
    }
    const scopes = parseScopes(row.grant.scopes);
    if (requested?.some((s) => !scopes.some((g) => g === s))) {
      throw new InvalidGrantError('申请的 scope 超出了原授权');
    }
    // 条件删除保证并发刷新只有一个成功（另一个拿着同一个旧 refresh 会 count=0）
    const del = await this.prisma.mcpToken.deleteMany({
      where: { id: row.id },
    });
    if (del.count === 0) {
      throw new InvalidGrantError('refresh token 已被使用');
    }
    return this.issuePair(row.grantId, scopes);
  }

  /** RFC 7009：吊销某个令牌 → 整条授权作废（access 与 refresh 一起）；不认识的令牌什么都不做 */
  async revokeByToken(clientId: string, raw: string): Promise<void> {
    const row = await this.prisma.mcpToken.findUnique({
      where: { hash: hashToken(raw) },
      include: { grant: true },
    });
    if (!row || row.grant.clientId !== clientId) return;
    await this.prisma.mcpGrant.updateMany({
      where: { id: row.grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ───────────────────────────── 校验 ─────────────────────────────

  /** 校验访问令牌（OAuth access 或 PAT）；无效返回 null */
  async verify(raw: string): Promise<McpPrincipal | null> {
    const row = await this.prisma.mcpToken.findUnique({
      where: { hash: hashToken(raw) },
      include: { grant: true },
    });
    if (!row || (row.kind !== 'access' && row.kind !== 'pat')) return null;
    const now = new Date();
    const { grant } = row;
    if (grant.revokedAt) return null;
    if (row.expiresAt && row.expiresAt <= now) return null;
    if (grant.expiresAt && grant.expiresAt <= now) return null;
    if (
      !grant.lastUsedAt ||
      now.getTime() - grant.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS
    ) {
      await this.prisma.mcpGrant.update({
        where: { id: grant.id },
        data: { lastUsedAt: now },
      });
    }
    return {
      grantId: grant.id,
      userId: grant.userId,
      tenantId: grant.tenantId,
      name: grant.name,
      clientId: grant.clientId,
      agent: null,
      scopes: parseScopes(grant.scopes),
      expiresAt: row.expiresAt
        ? Math.floor(row.expiresAt.getTime() / 1000)
        : null,
    };
  }

  /**
   * 是哪个 agent 在用这条授权：取客户端在 initialize 里自报的 clientInfo（title 优先），记进 Redis
   * 供之后的工具调用用——服务是无状态的，后续请求不再带这个信息。没报过时 OAuth 授权退回 DCR 注册名，
   * PAT 为 null。同一个 PAT 配在多个客户端里时，取最近一次 initialize 的那个。
   */
  async agentOf(p: McpPrincipal, body: unknown): Promise<string | null> {
    const init = initializeSchema.safeParse(body);
    if (init.success) {
      const { name, title } = init.data.params.clientInfo;
      const display = title?.trim() || name.trim();
      await this.redis.set(
        clientKey(p.grantId),
        display,
        'EX',
        CLIENT_INFO_TTL_S,
      );
      return display;
    }
    const remembered = await this.redis.get(clientKey(p.grantId));
    return remembered ?? (p.clientId ? p.name : null);
  }

  private async issuePair(
    grantId: string,
    scopes: McpScope[],
  ): Promise<OAuthTokens> {
    const access = newToken('access');
    const refresh = newToken('refresh');
    await this.prisma.mcpToken.createMany({
      data: [
        {
          grantId,
          kind: 'access',
          hash: hashToken(access),
          expiresAt: secondsFromNow(ACCESS_TOKEN_TTL_S),
        },
        {
          grantId,
          kind: 'refresh',
          hash: hashToken(refresh),
          expiresAt: secondsFromNow(REFRESH_TOKEN_TTL_S),
        },
      ],
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }
}

function toDto(
  g: {
    id: string;
    kind: string;
    name: string;
    scopes: unknown;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
  },
  agent: string | null = null,
): McpGrantDto {
  return {
    id: g.id,
    kind: g.kind === 'pat' ? 'pat' : 'oauth',
    name: g.name,
    scopes: parseScopes(g.scopes),
    createdAt: g.createdAt.toISOString(),
    lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    expiresAt: g.expiresAt?.toISOString() ?? null,
    agent,
  };
}
