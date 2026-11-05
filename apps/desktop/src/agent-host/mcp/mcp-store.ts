/**
 * MCP 连接器（desktop 版的 McpService，逐项对照 apps/backend/src/mcp/mcp.service.ts）：
 * 增删、推荐连接器、启停、连接 / 断开（含 OAuth 2.1：发现 + 动态注册 + PKCE + 刷新）、工具权限，
 * 运行期给 agent 装配工具（runtimeServers / callTool），以及 MCP Apps 的资源读取、
 * App 发起的工具调用与 ui/update-model-context。
 *
 * 与 Web 的差异只在宿主侧：授权页在系统浏览器打开，回调到本机 loopback 地址（RFC 8252，
 * 见 oauth-callback.ts）；进行中的授权（state → PKCE verifier）加密落库，agent-host 重启不丢；
 * App 的 sandbox 源是 main 进程注册的自定义协议 spark-mcp://m-<hash>。
 * 凭据经 agent-core 的 encryptJson 加密存库；密钥 MCP_TOKEN_ENC_KEY 由 main 生成并存系统钥匙串。
 */
import { createHash, randomUUID } from 'node:crypto';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  McpOAuthProvider,
  type OAuthStore,
  type StoredOAuthClient,
  withMcpClient,
} from '@agent-test/agent-core/mcp/mcp-client';
import { decryptJson, encryptJson } from '@agent-test/agent-core/mcp/mcp-crypto';
import { slugify, uniqueSlug } from '@agent-test/agent-core/mcp/mcp-naming';
import { toToolSnapshot } from '@agent-test/agent-core/mcp/mcp-result';
import {
  effectivePermission,
  McpAuthRequiredError,
  type McpToolSnapshot,
  type RuntimeServer,
  type ToolPermission,
} from '@agent-test/agent-core/mcp/mcp-types';
import { z } from 'zod';
import {
  type ConnectResult,
  MCP_SANDBOX_SCHEME,
  type McpAppResource,
  type McpPreset,
  type McpServer,
  type McpServerInfo,
  type McpServerStatus,
} from '../../shared/mcp';
import type { Db } from '../db/database';
import { type AppContextEntry, appContextMap, appContextOf } from './mcp-app-context';
import { mcpPresets } from './mcp-presets';

const CALL_TIMEOUT_MS = 120_000;
/** 未完成的授权保留 10 分钟（state → verifier），同 backend 的 Redis TTL */
const PENDING_TTL_MS = 10 * 60_000;
/** 每个会话最多保留最近 10 个 App 的上下文 */
const MAX_APP_CONTEXTS = 10;

export class McpError extends Error {}

const snapshotSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  modelSchema: z.record(z.string(), z.unknown()).nullable(),
  incompatibleReason: z.string().optional(),
  readOnly: z.boolean(),
  destructive: z.boolean(),
  uiResourceUri: z.string().optional(),
  visibility: z.array(z.enum(['model', 'app'])),
});
const permissionsSchema = z.record(z.string(), z.enum(['allow', 'ask', 'deny']));
const serverInfoSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  version: z.string().optional(),
  websiteUrl: z.string().optional(),
  description: z.string().optional(),
  iconUrl: z.string().optional(),
});
const STATUSES = ['disconnected', 'connected', 'needs_auth', 'error'] as const;

/** UI 资源的 `_meta.ui`（规范 McpUiResourceMeta）：只取卡片用到的字段，形状不对的整体当没声明 */
const domainList = z.array(z.string()).optional();
const permissionGrant = z.object({}).loose().optional();
const uiMetaSchema = z
  .object({
    ui: z
      .object({
        csp: z
          .object({
            connectDomains: domainList,
            resourceDomains: domainList,
            frameDomains: domainList,
            baseUriDomains: domainList,
          })
          .optional(),
        permissions: z
          .object({
            camera: permissionGrant,
            microphone: permissionGrant,
            geolocation: permissionGrant,
            clipboardWrite: permissionGrant,
          })
          .optional(),
        prefersBorder: z.boolean().optional(),
      })
      .optional(),
  })
  .loose();

const serverRow = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  url: z.string(),
  preset_key: z.string().nullable(),
  enabled: z.number(),
  status: z.enum(STATUSES).catch('disconnected'),
  last_error: z.string().nullable(),
  auth_type: z.string(),
  server_info: z.string().nullable(),
  instructions: z.string().nullable(),
  tools: z.string(),
  tools_refreshed_at: z.number().nullable(),
  permissions: z.string(),
  oauth_client: z.string().nullable(),
  oauth_tokens: z.string().nullable(),
});
type ServerRow = z.infer<typeof serverRow>;

const pendingRow = z.object({
  server_id: z.string(),
  verifier: z.string(),
  expires_at: z.number(),
});

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function snapshotsOf(row: ServerRow): McpToolSnapshot[] {
  const parsed = z.array(snapshotSchema).safeParse(parseJson(row.tools));
  return parsed.success ? parsed.data : [];
}

function permissionsOf(row: ServerRow): Record<string, ToolPermission> {
  const parsed = permissionsSchema.safeParse(parseJson(row.permissions));
  return parsed.success ? parsed.data : {};
}

function serverInfoOf(row: ServerRow): McpServerInfo | null {
  const parsed = serverInfoSchema.safeParse(parseJson(row.server_info));
  return parsed.success ? parsed.data : null;
}

/** 只接受 https；http 仅限本机（本地开发的 MCP server）。同 backend validateUrl */
export function validateMcpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new McpError('连接器地址无效');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new McpError('连接器地址必须是 https（本机地址可以用 http）');
  }
  u.hash = '';
  return u.toString();
}

/** 每个连接器一个 sandbox 源：spark-mcp://m-<server id 的 sha256 前 16 位>（不暴露原始 id） */
export function sandboxOrigin(serverId: string): string {
  const hash = createHash('sha256').update(serverId).digest('hex').slice(0, 16);
  return `${MCP_SANDBOX_SCHEME}://m-${hash}`;
}

type Patch = Partial<{
  name: string;
  enabled: number;
  status: McpServerStatus;
  last_error: string | null;
  auth_type: string;
  server_info: string | null;
  instructions: string | null;
  tools: string;
  tools_refreshed_at: number;
  permissions: string;
  oauth_client: string | null;
  oauth_tokens: string | null;
}>;

export class McpStore {
  constructor(
    private readonly db: Db,
    /** loopback 回调地址，如 http://127.0.0.1:47391/mcp/oauth/callback */
    private readonly redirectUri: string,
    /** 首次需要授权时确保回调服务已在监听 */
    private readonly ensureCallbackServer: () => Promise<void>,
  ) {}

  // ── 管理面 ───────────────────────────────────────────────────────────────

  /** 已添加的连接器 + 还没添加过的推荐连接器 */
  list(): { servers: McpServer[]; presets: McpPreset[] } {
    const rows = this.rows();
    const used = new Set(rows.map((r) => r.preset_key).filter(Boolean));
    return {
      servers: rows.map((r) => this.view(r)),
      presets: mcpPresets().filter((p) => !used.has(p.key)),
    };
  }

  get(id: string): McpServer {
    return this.view(this.row(id));
  }

  /** 添加并立即连接（名字缺省用域名，连上后若 server 自报 title 则换成它） */
  add(url: string, name?: string): Promise<ConnectResult> {
    const clean = validateMcpUrl(url);
    const id = this.insert(name?.trim() || new URL(clean).hostname, clean, null);
    return this.connect(id);
  }

  /** 推荐连接器：已添加过就直接重连那一条 */
  addPreset(key: string): Promise<ConnectResult> {
    const preset = mcpPresets().find((p) => p.key === key);
    if (!preset) throw new McpError(`没有这个推荐连接器：${key}`);
    const existing = this.rows().find((r) => r.preset_key === key);
    const id = existing?.id ?? this.insert(preset.name, validateMcpUrl(preset.url), key);
    return this.connect(id);
  }

  remove(id: string): void {
    this.row(id);
    this.db.prepare('DELETE FROM mcp_server WHERE id = ?').run(id);
  }

  update(
    id: string,
    patch: { enabled?: boolean; toolPermissions?: Record<string, ToolPermission> },
  ): McpServer {
    const row = this.row(id);
    const fields: Patch = {};
    if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0;
    if (patch.toolPermissions) {
      fields.permissions = JSON.stringify({ ...permissionsOf(row), ...patch.toolPermissions });
    }
    this.patch(id, fields);
    return this.get(id);
  }

  /** 断开：清掉 token（保留 DCR 注册，重连时少一次注册），工具快照留着供查看 */
  disconnect(id: string): McpServer {
    this.row(id);
    this.patch(id, { oauth_tokens: null, status: 'disconnected', last_error: null });
    return this.get(id);
  }

  async connect(id: string): Promise<ConnectResult> {
    const row = this.row(id);
    const provider = this.provider(row);
    try {
      await this.refreshWith(row, provider);
      return { status: 'connected', server: this.get(id) };
    } catch (e) {
      if (provider.authorizationUrl && provider.pendingVerifier) {
        await this.ensureCallbackServer();
        this.db
          .prepare('DELETE FROM mcp_oauth_pending WHERE expires_at < ?')
          .run(Date.now());
        this.db
          .prepare(
            'INSERT OR REPLACE INTO mcp_oauth_pending (state, server_id, verifier, expires_at) VALUES (?, ?, ?, ?)',
          )
          .run(
            provider.state(),
            id,
            encryptJson({ verifier: provider.pendingVerifier }) ?? '',
            Date.now() + PENDING_TTL_MS,
          );
        this.patch(id, { status: 'needs_auth', auth_type: 'oauth', last_error: null });
        return {
          status: 'needs_auth',
          server: this.get(id),
          authorizationUrl: provider.authorizationUrl.toString(),
        };
      }
      const error = e instanceof Error ? e.message : String(e);
      this.patch(id, { status: 'error', last_error: error.slice(0, 2000) });
      return { status: 'error', server: this.get(id), error };
    }
  }

  /** loopback 回调：state 换回 verifier（一次性）→ 授权码换 token → 刷新工具快照 */
  async completeOAuth(code: string, state: string): Promise<McpServer> {
    const raw = this.db.prepare('SELECT * FROM mcp_oauth_pending WHERE state = ?').get(state);
    this.db.prepare('DELETE FROM mcp_oauth_pending WHERE state = ?').run(state);
    const p = raw ? pendingRow.parse(raw) : null;
    if (!p || p.expires_at < Date.now()) {
      throw new McpError('授权已过期或无效，请回到 Spark 重新连接');
    }
    const verifier = z
      .object({ verifier: z.string() })
      .safeParse(decryptJson<unknown>(p.verifier));
    if (!verifier.success) throw new McpError('授权状态损坏，请回到 Spark 重新连接');
    const row = this.row(p.server_id);
    const provider = this.provider(row, { state, codeVerifier: verifier.data.verifier });
    await auth(provider, { serverUrl: row.url, authorizationCode: code });
    await this.refreshWith(row, provider);
    return this.get(row.id);
  }

  /** 是否有未过期的授权在等回调（agent-host 重启后据此重新监听 loopback 端口） */
  hasPendingAuth(): boolean {
    return !!this.db
      .prepare('SELECT 1 AS x FROM mcp_oauth_pending WHERE expires_at > ? LIMIT 1')
      .get(Date.now());
  }

  // ── 运行期 ───────────────────────────────────────────────────────────────

  runtimeServers(): RuntimeServer[] {
    return this.rows()
      .filter((r) => r.enabled === 1 && r.status === 'connected')
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        instructions: r.instructions,
        tools: snapshotsOf(r),
        permissions: permissionsOf(r),
      }));
  }

  callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.request(this.row(serverId), (client) =>
      client
        .callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
        .then(asCallToolResult),
    );
  }

  // ── MCP Apps ─────────────────────────────────────────────────────────────

  /**
   * App（iframe）发起的 tools/call，校验同 backend callToolFromApp：
   * 工具必须在快照里且 visibility 含 app；禁用的拒绝；需审批且模型可见的必须带 confirmed。
   */
  callToolFromApp(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    confirmed: boolean,
  ): Promise<CallToolResult> {
    const row = this.row(serverId);
    const tool = snapshotsOf(row).find((t) => t.name === name);
    if (!tool) throw new McpError(`工具不存在：${name}`);
    const permission = effectivePermission(tool, permissionsOf(row));
    if (!tool.visibility.includes('app') || permission === 'deny') {
      throw new McpError(`这个工具不允许由卡片调用：${name}`);
    }
    if (permission === 'ask' && tool.visibility.includes('model') && !confirmed) {
      throw new McpError(`调用 ${name} 需要先经你确认`);
    }
    return this.callTool(serverId, name, args);
  }

  readResource(serverId: string, uri: string): Promise<ReadResourceResult> {
    return this.request(this.row(serverId), (client) => client.readResource({ uri }));
  }

  /** App 卡片需要的东西：UI 资源 + 该 server 的 sandbox 源 + 工具快照（审批判断用） */
  async appResource(serverId: string, uri: string): Promise<McpAppResource> {
    const row = this.row(serverId);
    const resource = await this.readResource(serverId, uri);
    const content = resource.contents.find((c) => c.uri === uri) ?? resource.contents[0];
    if (!content) throw new McpError('连接器没有返回卡片内容');
    const html =
      'text' in content ? content.text : Buffer.from(content.blob, 'base64').toString('utf8');
    const meta = uiMetaSchema.safeParse(content._meta);
    return {
      html,
      mimeType: content.mimeType ?? null,
      meta: meta.success ? { ui: meta.data.ui } : null,
      sandboxOrigin: sandboxOrigin(row.id),
      serverName: row.name,
      tools: snapshotsOf(row).map((t) => ({
        name: t.name,
        title: t.title,
        visibility: t.visibility,
        permission: effectivePermission(t, permissionsOf(row)),
      })),
    };
  }

  /** ui/update-model-context：按会话存（每个 App 只留最新一份，最多 10 个），下一轮注入系统提示 */
  setAppContext(conversationId: string, toolCallId: string, serverId: string, text: string): void {
    const server = this.row(serverId);
    const r = this.db
      .prepare('SELECT mcp_app_context FROM conversation WHERE id = ?')
      .get(conversationId);
    if (!r) throw new McpError(`会话不存在：${conversationId}`);
    const cur = z.object({ mcp_app_context: z.string().nullable() }).parse(r).mcp_app_context;
    const prev = appContextMap(parseJson(cur));
    // at 严格递增：同一毫秒里连发多次时，「最新」仍然确定（排序与淘汰都按它）
    const latest = Math.max(0, ...Object.values(prev).map((e) => e.at));
    const next: Record<string, AppContextEntry> = {
      ...prev,
      [toolCallId]: { server: server.name, text, at: Math.max(Date.now(), latest + 1) },
    };
    const kept = Object.fromEntries(
      Object.entries(next)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, MAX_APP_CONTEXTS),
    );
    this.db
      .prepare('UPDATE conversation SET mcp_app_context = ? WHERE id = ?')
      .run(JSON.stringify(kept), conversationId);
  }

  /** 注入系统提示用的 App 上下文（按时间先后） */
  appContext(conversationId: string): AppContextEntry[] {
    const r = this.db
      .prepare('SELECT mcp_app_context FROM conversation WHERE id = ?')
      .get(conversationId);
    if (!r) return [];
    return appContextOf(
      parseJson(z.object({ mcp_app_context: z.string().nullable() }).parse(r).mcp_app_context),
    );
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private insert(name: string, url: string, presetKey: string | null): string {
    const taken = new Set(this.rows().map((r) => r.slug));
    const slug = uniqueSlug(slugify(name) || 'mcp', taken);
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mcp_server (id, name, slug, url, preset_key, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'disconnected', ?, ?)`,
      )
      .run(id, name.slice(0, 60), slug, url, presetKey, now, now);
    return id;
  }

  private rows(): ServerRow[] {
    return this.db
      .prepare('SELECT * FROM mcp_server ORDER BY created_at ASC')
      .all()
      .map((r) => serverRow.parse(r));
  }

  private row(id: string): ServerRow {
    const r = this.db.prepare('SELECT * FROM mcp_server WHERE id = ?').get(id);
    if (!r) throw new McpError(`连接器不存在：${id}`);
    return serverRow.parse(r);
  }

  private patch(id: string, fields: Patch): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    // 列名来自上面的固定字段表（类型限定），不是外部输入
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE mcp_server SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v ?? null), Date.now(), id);
  }

  private view(row: ServerRow): McpServer {
    const perms = permissionsOf(row);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      url: row.url,
      presetKey: row.preset_key,
      enabled: row.enabled === 1,
      status: row.status,
      lastError: row.last_error,
      authType: row.auth_type,
      serverInfo: serverInfoOf(row),
      tools: snapshotsOf(row).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        modelSchema: t.modelSchema,
        incompatibleReason: t.incompatibleReason,
        readOnly: t.readOnly,
        destructive: t.destructive,
        uiResourceUri: t.uiResourceUri,
        visibility: t.visibility,
        permission: effectivePermission(t, perms),
      })),
      toolsRefreshedAt: row.tools_refreshed_at ? new Date(row.tools_refreshed_at).toISOString() : null,
    };
  }

  private oauthStore(id: string): OAuthStore {
    return {
      getClient: () => Promise.resolve(decryptJson<StoredOAuthClient>(this.row(id).oauth_client)),
      saveClient: (client) => {
        this.patch(id, { oauth_client: encryptJson(client), auth_type: 'oauth' });
        return Promise.resolve();
      },
      getTokens: () => Promise.resolve(decryptJson<OAuthTokens>(this.row(id).oauth_tokens)),
      saveTokens: (tokens) => {
        this.patch(id, { oauth_tokens: encryptJson(tokens), auth_type: 'oauth' });
        return Promise.resolve();
      },
      clearTokens: () => {
        this.patch(id, { oauth_tokens: null });
        return Promise.resolve();
      },
      clearClient: () => {
        this.patch(id, { oauth_client: null });
        return Promise.resolve();
      },
    };
  }

  private provider(
    row: ServerRow,
    opts: { state?: string; codeVerifier?: string } = {},
  ): McpOAuthProvider {
    return new McpOAuthProvider(this.oauthStore(row.id), this.redirectUri, opts);
  }

  /** 运行期请求统一入口：授权失效 → 标记 needs_auth 并抛 McpAuthRequiredError（同 backend request） */
  private async request<T>(row: ServerRow, fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await withMcpClient(row.url, this.provider(row), fn);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        this.patch(row.id, { status: 'needs_auth' });
        throw new McpAuthRequiredError(row.id, row.name);
      }
      throw e;
    }
  }

  /** 握手 + 拉全量工具（分页）→ 落快照与 server 自报信息，置 connected */
  private async refreshWith(row: ServerRow, provider: McpOAuthProvider): Promise<void> {
    const { info, instructions, tools } = await withMcpClient(
      row.url,
      provider,
      async (client: Client) => {
        const all: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          all.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        const v = client.getServerVersion();
        const serverInfo: McpServerInfo | null = v
          ? {
              name: v.name,
              title: v.title,
              version: v.version,
              websiteUrl: v.websiteUrl,
              description:
                'description' in v && typeof v.description === 'string' ? v.description : undefined,
              iconUrl: v.icons?.[0]?.src,
            }
          : null;
        return {
          info: serverInfo,
          instructions: client.getInstructions() ?? null,
          tools: all.map(toToolSnapshot),
        };
      },
    );
    this.patch(row.id, {
      status: 'connected',
      last_error: null,
      // 用户没改过名字（还是域名）时，用 server 自报的 title
      name: row.name === new URL(row.url).hostname && info?.title ? info.title : row.name,
      server_info: info ? JSON.stringify(info) : null,
      instructions,
      tools: JSON.stringify(tools),
      tools_refreshed_at: Date.now(),
    });
  }
}

/** SDK 的 callTool 返回类型含旧协议的 toolResult 形态；只认新形态（同 backend McpService），用 SDK 自带 schema 收窄 */
function asCallToolResult(r: Awaited<ReturnType<Client['callTool']>>): CallToolResult {
  const parsed = CallToolResultSchema.safeParse(r);
  if (parsed.success) return parsed.data;
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
}
