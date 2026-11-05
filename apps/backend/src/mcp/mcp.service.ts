import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { McpServer, Prisma } from '@prisma/client';
import {
  auth,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  CallToolResult,
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Redis } from 'ioredis';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  McpOAuthProvider,
  type OAuthStore,
  type StoredOAuthClient,
  withMcpClient,
} from './mcp-client';
import { appContextMap } from './mcp-app-context';
import { decryptJson, encryptJson } from './mcp-crypto';
import { slugify, uniqueSlug } from './mcp-naming';
import { mcpPresets } from './mcp-presets';
import { toToolSnapshot } from './mcp-result';
import { hostOrigins, sandboxOrigin } from './mcp-sandbox';
import {
  effectivePermission,
  type McpServerInfo,
  type McpServerStatus,
  type McpToolSnapshot,
  TOOL_PERMISSIONS,
  type ToolPermission,
} from './mcp-types';

/** OAuth 授权进行中的状态（Redis，按 state 索引，10 分钟过期、用一次即删）。 */
interface PendingAuth {
  userId: string;
  serverId: string;
  verifier: string;
}

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `mcp:oauth:${state}`;

/** 工具调用超时：生成类工具是异步任务（立即返回 taskId），2 分钟足够覆盖慢 server。 */
const CALL_TIMEOUT_MS = 120_000;

/** 连接器的对外视图（不含任何凭据）。 */
export interface McpServerView {
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
  tools: (McpToolSnapshot & { permission: ToolPermission })[];
  toolsRefreshedAt: Date | null;
}

export type ConnectResult =
  | { status: 'connected'; server: McpServerView }
  | { status: 'needs_auth'; server: McpServerView; authorizationUrl: string }
  | { status: 'error'; server: McpServerView; error: string };

import { McpAuthRequiredError, type RuntimeServer } from './mcp-types';

// 定义已移到 mcp-types.ts（不依赖 Nest / Prisma），这里保留导出供既有调用方使用
export { McpAuthRequiredError, type RuntimeServer };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** McpServer.tools 是我方写入的快照数组，形状由 toToolSnapshot 保证。 */
function snapshotOf(row: Pick<McpServer, 'tools'>): McpToolSnapshot[] {
  return Array.isArray(row.tools)
    ? (row.tools as unknown as McpToolSnapshot[])
    : [];
}

function permissionsOf(
  row: Pick<McpServer, 'toolPermissions'>,
): Record<string, ToolPermission> {
  const raw = row.toolPermissions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ToolPermission> = {};
  for (const [k, v] of Object.entries(raw)) {
    if ((TOOL_PERMISSIONS as readonly unknown[]).includes(v)) {
      out[k] = v as ToolPermission;
    }
  }
  return out;
}

function serverInfoOf(
  row: Pick<McpServer, 'serverInfo'>,
): McpServerInfo | null {
  const v = row.serverInfo;
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as unknown as McpServerInfo)
    : null;
}

/** 只接受 https；http 仅限本机（本地开发的 MCP server）。 */
function validateUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new BusinessException(ErrorCodes.MCP_INVALID_URL);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new BusinessException(ErrorCodes.MCP_INVALID_URL);
  }
  u.hash = '';
  return u.toString();
}

/**
 * OAuth 回调地址：浏览器可达的主站地址 + BFF 前缀（/api-backend 反代到后端）。
 * MCP_OAUTH_REDIRECT_URI 可整体覆盖；变了的话旧的 DCR 注册会作废并自动重新注册。
 */
export function oauthRedirectUri(): string {
  return (
    process.env.MCP_OAUTH_REDIRECT_URI ??
    `${hostOrigins()[0]}/api-backend/mcp/oauth/callback`
  );
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ───────────────────────────── 管理（设置页） ─────────────────────────────

  async list(userId: string) {
    const rows = await this.prisma.mcpServer.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    const added = new Set(rows.map((r) => r.presetKey).filter(Boolean));
    return {
      servers: rows.map((r) => this.view(r)),
      presets: mcpPresets().filter((p) => !added.has(p.key)),
    };
  }

  async get(userId: string, id: string): Promise<McpServerView> {
    return this.view(await this.findOwned(userId, id));
  }

  async create(
    userId: string,
    input: { url: string; name?: string; presetKey?: string },
  ): Promise<ConnectResult> {
    const url = validateUrl(input.url);
    const exists = await this.prisma.mcpServer.findFirst({
      where: { userId, url },
    });
    if (exists) {
      throw new BusinessException(
        ErrorCodes.MCP_SERVER_EXISTS,
        HttpStatus.CONFLICT,
      );
    }
    const name = input.name?.trim() || new URL(url).hostname;
    const taken = new Set(
      (
        await this.prisma.mcpServer.findMany({
          where: { userId },
          select: { slug: true },
        })
      ).map((r) => r.slug),
    );
    const row = await this.prisma.mcpServer.create({
      data: {
        userId,
        url,
        name,
        slug: uniqueSlug(slugify(name), taken),
        presetKey: input.presetKey ?? null,
      },
    });
    return this.connect(userId, row.id);
  }

  /** 推荐连接器：已添加过就直接（重新）连接，否则按预设建一条。 */
  async addPreset(userId: string, key: string): Promise<ConnectResult> {
    const preset = mcpPresets().find((p) => p.key === key);
    if (!preset) {
      throw new BusinessException(
        ErrorCodes.MCP_PRESET_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const existing = await this.prisma.mcpServer.findFirst({
      where: { userId, presetKey: key },
    });
    if (existing) return this.connect(userId, existing.id);
    return this.create(userId, {
      url: preset.url,
      name: preset.name,
      presetKey: key,
    });
  }

  async update(
    userId: string,
    id: string,
    patch: {
      enabled?: boolean;
      toolPermissions?: Record<string, ToolPermission>;
    },
  ): Promise<McpServerView> {
    const row = await this.findOwned(userId, id);
    const data: Prisma.McpServerUpdateInput = {};
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.toolPermissions) {
      // 复用 permissionsOf 的取值校验：非法值直接丢弃
      data.toolPermissions = {
        ...permissionsOf(row),
        ...permissionsOf({ toolPermissions: patch.toolPermissions }),
      };
    }
    return this.view(
      await this.prisma.mcpServer.update({ where: { id: row.id }, data }),
    );
  }

  /** 断开：清掉 token（保留 DCR 注册，重连时少一次注册），工具快照留着供查看。 */
  async disconnect(userId: string, id: string): Promise<McpServerView> {
    const row = await this.findOwned(userId, id);
    return this.view(
      await this.prisma.mcpServer.update({
        where: { id: row.id },
        data: { oauthTokens: null, status: 'disconnected', lastError: null },
      }),
    );
  }

  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    const row = await this.findOwned(userId, id);
    await this.prisma.mcpServer.delete({ where: { id: row.id } });
    return { deleted: true };
  }

  /**
   * 连接 / 重连：握手成功就刷新工具快照；server 回 401 时 SDK 走完发现 + DCR + PKCE，
   * 把授权 URL 交给 provider —— 返回给前端弹窗打开，verifier 按 state 存 Redis 等回调。
   */
  async connect(userId: string, id: string): Promise<ConnectResult> {
    const row = await this.findOwned(userId, id);
    const provider = this.provider(row);
    try {
      const updated = await this.refreshWith(row, provider);
      return { status: 'connected', server: this.view(updated) };
    } catch (e) {
      if (provider.authorizationUrl && provider.pendingVerifier) {
        const pending: PendingAuth = {
          userId,
          serverId: row.id,
          verifier: provider.pendingVerifier,
        };
        await this.redis.set(
          stateKey(provider.state()),
          JSON.stringify(pending),
          'EX',
          STATE_TTL_SECONDS,
        );
        const updated = await this.prisma.mcpServer.update({
          where: { id: row.id },
          data: { status: 'needs_auth', authType: 'oauth', lastError: null },
        });
        return {
          status: 'needs_auth',
          server: this.view(updated),
          authorizationUrl: provider.authorizationUrl.toString(),
        };
      }
      const error = errorMessage(e);
      this.logger.warn(`MCP 连接失败 server=${row.id} ${row.url}: ${error}`);
      const updated = await this.prisma.mcpServer.update({
        where: { id: row.id },
        data: { status: 'error', lastError: error.slice(0, 2000) },
      });
      return { status: 'error', server: this.view(updated), error };
    }
  }

  /** OAuth 回调：state 换回 verifier → 用授权码换 token → 刷新工具快照。 */
  async completeOAuth(
    code: string,
    state: string,
  ): Promise<{ server: McpServerView }> {
    const raw = await this.redis.getdel(stateKey(state));
    if (!raw) throw new BusinessException(ErrorCodes.MCP_OAUTH_STATE_INVALID);
    // 我方自己写入 Redis 的数据
    const pending = JSON.parse(raw) as PendingAuth;
    const row = await this.findOwned(pending.userId, pending.serverId);
    const provider = this.provider(row, {
      state,
      codeVerifier: pending.verifier,
    });
    await auth(provider, { serverUrl: row.url, authorizationCode: code });
    const updated = await this.refreshWith(row, provider);
    return { server: this.view(updated) };
  }

  async refresh(userId: string, id: string): Promise<ConnectResult> {
    return this.connect(userId, id);
  }

  // ───────────────────────────── 运行期（agent / App） ─────────────────────────────

  /** 本轮 agent 可用的连接器：已启用 + 已连接 + 有工具快照。 */
  async runtimeServers(userId: string): Promise<RuntimeServer[]> {
    const rows = await this.prisma.mcpServer.findMany({
      where: { userId, enabled: true, status: 'connected' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      instructions: r.instructions,
      tools: snapshotOf(r),
      permissions: permissionsOf(r),
    }));
  }

  /**
   * agent 发起的工具调用（权限已在装配时按快照过滤，审批由 interruptOn 完成）。
   * token 失效且刷新失败 → 标记 needs_auth 并抛 McpAuthRequiredError。
   */
  async callTool(
    userId: string,
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const row = await this.findOwned(userId, serverId);
    return this.request(row, (client) =>
      client
        .callTool({ name, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        })
        .then((r) => this.asCallToolResult(r)),
    );
  }

  /**
   * App（iframe）发起的 tools/call（设计 Q10）：
   * - 工具必须在该 server 的快照里，且 visibility 含 app（规范硬性要求）；
   * - 用户设为禁用的拒绝；需审批的必须带 confirmed（前端已弹确认）；
   * - 仅 App 可见的内部工具（visibility 只有 app）不走审批。
   */
  async callToolFromApp(
    userId: string,
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<CallToolResult> {
    const row = await this.findOwned(userId, serverId);
    const tool = snapshotOf(row).find((t) => t.name === name);
    if (!tool) {
      throw new BusinessException(
        ErrorCodes.MCP_TOOL_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const appOnly = !tool.visibility.includes('model');
    const permission = effectivePermission(tool, permissionsOf(row));
    if (!tool.visibility.includes('app') || permission === 'deny') {
      throw new BusinessException(
        ErrorCodes.MCP_TOOL_NOT_ALLOWED,
        HttpStatus.FORBIDDEN,
      );
    }
    if (permission === 'ask' && !appOnly && !confirmed) {
      throw new BusinessException(ErrorCodes.MCP_TOOL_NEEDS_CONFIRM);
    }
    return this.callTool(userId, serverId, name, args);
  }

  async readResource(
    userId: string,
    serverId: string,
    uri: string,
  ): Promise<ReadResourceResult> {
    const row = await this.findOwned(userId, serverId);
    return this.request(row, (client) => client.readResource({ uri }));
  }

  /** App 卡片需要的东西：UI 资源 + 该 server 的 sandbox 源 + 工具快照（审批判断用）。 */
  async appResource(userId: string, serverId: string, uri: string) {
    const row = await this.findOwned(userId, serverId);
    const resource = await this.request(row, (client) =>
      client.readResource({ uri }),
    );
    const content =
      resource.contents.find((c) => c.uri === uri) ?? resource.contents[0];
    if (!content) {
      throw new BusinessException(
        ErrorCodes.MCP_REQUEST_FAILED,
        HttpStatus.BAD_GATEWAY,
      );
    }
    const html =
      'text' in content
        ? content.text
        : Buffer.from(content.blob, 'base64').toString('utf8');
    return {
      html,
      mimeType: content.mimeType ?? null,
      meta: content._meta ?? null,
      sandboxOrigin: sandboxOrigin(row.id),
      serverName: row.name,
      tools: snapshotOf(row).map((t) => ({
        name: t.name,
        title: t.title,
        visibility: t.visibility,
        permission: effectivePermission(t, permissionsOf(row)),
      })),
    };
  }

  /**
   * ui/update-model-context：按会话存（每个 App 只留最新一份），下一轮注入系统提示。
   * 最多保留最近 10 个 App 的上下文，防无限增长。
   */
  async setAppContext(
    userId: string,
    conversationId: string,
    toolCallId: string,
    serverName: string,
    text: string,
  ): Promise<{ ok: true }> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
      select: { id: true, mcpAppContext: true },
    });
    if (!conv) {
      throw new BusinessException(
        ErrorCodes.CONVERSATION_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    const next = {
      ...appContextMap(conv.mcpAppContext),
      [toolCallId]: { server: serverName, text, at: Date.now() },
    };
    const kept = Object.fromEntries(
      Object.entries(next)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 10)
        .map(([k, e]) => [k, { server: e.server, text: e.text, at: e.at }]),
    );
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { mcpAppContext: kept },
    });
    return { ok: true };
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private async findOwned(userId: string, id: string): Promise<McpServer> {
    const row = await this.prisma.mcpServer.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new BusinessException(
        ErrorCodes.MCP_SERVER_NOT_FOUND,
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /** 加密列实现的 OAuthStore：每次读最新行，避免并发刷新时拿到旧 token。 */
  private store(serverId: string): OAuthStore {
    const read = () =>
      this.prisma.mcpServer.findUniqueOrThrow({
        where: { id: serverId },
        select: { oauthClient: true, oauthTokens: true },
      });
    const write = async (data: Prisma.McpServerUpdateInput) => {
      await this.prisma.mcpServer.update({ where: { id: serverId }, data });
    };
    return {
      getClient: async () =>
        decryptJson<StoredOAuthClient>((await read()).oauthClient),
      saveClient: (client) =>
        write({ oauthClient: encryptJson(client), authType: 'oauth' }),
      getTokens: async () =>
        decryptJson<OAuthTokens>((await read()).oauthTokens),
      saveTokens: (tokens) =>
        write({ oauthTokens: encryptJson(tokens), authType: 'oauth' }),
      clearTokens: () => write({ oauthTokens: null }),
      clearClient: () => write({ oauthClient: null }),
    };
  }

  private provider(
    row: McpServer,
    opts?: { state?: string; codeVerifier?: string },
  ): McpOAuthProvider {
    return new McpOAuthProvider(this.store(row.id), oauthRedirectUri(), opts);
  }

  /** 握手 + 拉全量工具（分页）→ 落快照，置 connected。 */
  private async refreshWith(
    row: McpServer,
    provider: McpOAuthProvider,
  ): Promise<McpServer> {
    const { info, instructions, tools } = await withMcpClient(
      row.url,
      provider,
      async (client) => {
        const all: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          all.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        const v = client.getServerVersion();
        const info: McpServerInfo | null = v
          ? {
              name: v.name,
              title: v.title,
              version: v.version,
              websiteUrl: v.websiteUrl,
              description:
                'description' in v && typeof v.description === 'string'
                  ? v.description
                  : undefined,
              iconUrl: v.icons?.[0]?.src,
            }
          : null;
        return {
          info,
          instructions: client.getInstructions() ?? null,
          tools: all.map(toToolSnapshot),
        };
      },
    );
    return this.prisma.mcpServer.update({
      where: { id: row.id },
      data: {
        status: 'connected',
        lastError: null,
        // 用户没改过名字（还是域名）时，用 server 自报的 title
        name:
          row.name === new URL(row.url).hostname && info?.title
            ? info.title
            : row.name,
        serverInfo: info ? { ...info } : undefined,
        instructions,
        tools: tools as unknown as Prisma.InputJsonValue,
        toolsRefreshedAt: new Date(),
      },
    });
  }

  /** 运行期请求统一入口：授权失效 → 标记 needs_auth 并抛 McpAuthRequiredError。 */
  private async request<T>(
    row: McpServer,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    try {
      return await withMcpClient(row.url, this.provider(row), fn);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        await this.prisma.mcpServer.update({
          where: { id: row.id },
          data: { status: 'needs_auth' },
        });
        throw new McpAuthRequiredError(row.id, row.name);
      }
      throw e;
    }
  }

  /** SDK 的 callTool 返回类型含旧协议的 toolResult 形态；我们只认新形态。 */
  private asCallToolResult(
    r: Awaited<ReturnType<Client['callTool']>>,
  ): CallToolResult {
    if ('content' in r && Array.isArray(r.content)) return r as CallToolResult;
    return {
      content: [{ type: 'text', text: JSON.stringify(r) }],
    };
  }

  private view(row: McpServer): McpServerView {
    const perms = permissionsOf(row);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      url: row.url,
      presetKey: row.presetKey,
      enabled: row.enabled,
      status: row.status as McpServerStatus,
      lastError: row.lastError,
      authType: row.authType,
      serverInfo: serverInfoOf(row),
      tools: snapshotOf(row).map((t) => ({
        ...t,
        permission: effectivePermission(t, perms),
      })),
      toolsRefreshedAt: row.toolsRefreshedAt,
    };
  }
}
