/**
 * MCP OAuth 的 loopback 回调服务（RFC 8252：原生应用用 127.0.0.1 回调）。
 * 端口固定：DCR 注册时登记的 redirect_uri 必须稳定，换端口会导致重新注册。
 * 只在第一次需要授权时才开始监听，之后常驻到 agent-host 退出。
 */
import { createServer, type Server } from 'node:http';
import { hostI18n } from '../i18n';

export const OAUTH_CALLBACK_PORT = 47391;
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

type CompleteFn = (code: string, state: string) => Promise<string>;

export function createOAuthCallbackServer(
  complete: CompleteFn,
  /** 授权被拒 / 换 token 失败：通知 renderer 结束「连接中」 */
  onFailure: (error: string) => void,
): () => Promise<void> {
  let server: Server | null = null;
  let listening: Promise<void> | null = null;

  return () => {
    if (listening) return listening;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', OAUTH_REDIRECT_URI);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const reply = (status: number, title: string, detail: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(title, detail));
      };
      if (error || !code || !state) {
        const detail = error ?? hostI18n.t('errors.oauth.missingParams');
        onFailure(detail);
        reply(400, hostI18n.t('errors.oauth.incomplete'), detail);
        return;
      }
      complete(code, state).then(
        (name) => reply(200, hostI18n.t('errors.oauth.done'), hostI18n.t('errors.oauth.connected', { name })),
        (e: unknown) => {
          const detail = e instanceof Error ? e.message : String(e);
          onFailure(detail);
          reply(400, hostI18n.t('errors.oauth.failed'), detail);
        },
      );
    });
    const s = server;
    listening = new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => resolve());
    });
    return listening;
  };
}

function page(title: string, detail: string): string {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui;padding:48px;line-height:1.6">
<h2>${esc(title)}</h2><p>${esc(detail)}</p></body>`;
}
