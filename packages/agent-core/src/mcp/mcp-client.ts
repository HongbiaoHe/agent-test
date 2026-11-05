import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/** MCP Apps 扩展标识（规范 §Extension Identifier）：握手时声明我们能渲染 App。 */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

/** DCR 注册结果 + 注册时用的 redirect_uri（redirect_uri 变了要重新注册）。 */
export interface StoredOAuthClient {
  info: OAuthClientInformationMixed;
  redirectUri: string;
}

/** provider 的持久化面：由 McpService 用加密列实现，这里不关心存在哪。 */
export interface OAuthStore {
  getClient(): Promise<StoredOAuthClient | undefined>;
  saveClient(client: StoredOAuthClient): Promise<void>;
  getTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  clearTokens(): Promise<void>;
  clearClient(): Promise<void>;
}

/**
 * SDK OAuthClientProvider 的服务端实现（MCP 授权规范：发现 → DCR → PKCE → 刷新都由 SDK 的 auth() 驱动）。
 *
 * 服务端没法「跳转」：SDK 需要用户授权时调 redirectToAuthorization，这里只把 URL 记下来，
 * 由调用方交给前端弹窗打开。PKCE verifier 同理先留在实例上，调用方存进 Redis（按 state 索引），
 * 回调时用 `codeVerifier` 选项带回来换 token。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  pendingVerifier?: string;
  private readonly stateValue: string;

  constructor(
    private readonly store: OAuthStore,
    private readonly redirectUri: string,
    opts: { state?: string; codeVerifier?: string } = {},
  ) {
    this.stateValue = opts.state ?? randomBytes(24).toString('base64url');
    this.pendingVerifier = opts.codeVerifier;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Spark Agent',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // 公开客户端（PKCE 保护），不持有 client_secret
      token_endpoint_auth_method: 'none',
    };
  }

  /** 本次授权的 state（调用方以它为键在 Redis 里存 userId / serverId / verifier）。 */
  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.store.getClient();
    // 回调地址变了（换了访问域名 / 端口），旧注册的 redirect_uris 不含新地址 → 当没注册，重新 DCR
    return stored?.redirectUri === this.redirectUri ? stored.info : undefined;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.store.saveClient({ info, redirectUri: this.redirectUri });
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.store.getTokens();
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.store.saveTokens(tokens);
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.pendingVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this.pendingVerifier) throw new Error('missing PKCE code verifier');
    return this.pendingVerifier;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') await this.store.clearTokens();
    if (scope === 'all' || scope === 'client') await this.store.clearClient();
  }
}

/** 单次连接超时：MCP 调用以短连为主，连不上就尽早失败，别拖住整轮 agent。 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * 建一条短连接（initialize 握手）→ 执行 fn → 关闭。设计 Q7：不维护连接池，
 * 每次工具调用 / App 代理请求各连一次，进程重启、多实例都不用管连接归属。
 * token 过期时 transport 会自己用 refresh_token 刷新；刷新也失败就经 provider.redirectToAuthorization
 * 记下授权 URL 并抛 UnauthorizedError，由调用方转成「需要重新授权」。
 */
export async function withMcpClient<T>(
  url: string,
  authProvider: OAuthClientProvider,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    { name: 'spark-agent', version: '1.0.0' },
    {
      capabilities: {
        extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } },
      },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider,
  });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}
