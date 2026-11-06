/**
 * MCP Apps 的 sandbox proxy（规范 §Sandbox proxy：宿主必须套一层与宿主**不同源**的代理 iframe）。
 *
 * Web 版用每个 server 一个子域名（apps/backend/src/mcp/mcp-sandbox.ts）；桌面端注册自定义协议
 * `spark-mcp://m-<hash>/`：每个连接器一个独立源，与 renderer（file:// 或 dev server）不同源，
 * App 互相读不到对方的存储，也拿不到 preload 暴露给主窗口的 window.desktop（preload 只注入主 frame）。
 *
 * 这个源上只有一个页面：外层代理 HTML（逻辑同 Web：自检确实被隔离 → 建内层 iframe →
 * 收到 sandbox-resource-ready 写入 View HTML，其余消息双向转发）。CSP 经响应头下发（View 无法篡改），
 * 由 `?csp=` 携带的 `_meta.ui.csp` 声明构造。其余路径一律 404。
 *
 * 与 Web 的差异：嵌入方是本应用自己的窗口（file:// 源是不透明源，postMessage 无法按源定向），
 * 所以不做 referrer 白名单，改为只认 window.parent 这个固定的消息来源、向它发消息时用 '*'。
 */
import { type CustomScheme, protocol } from 'electron';
import { MCP_SANDBOX_SCHEME } from '../shared/mcp';

const HOST_RE = /^m-[a-f0-9]{16}$/;

/**
 * 必须在 app ready 之前注册（main/index.ts 与其它特权协议一起，registerSchemesAsPrivileged 只能调一次）：
 * standard + secure 让它像 https 一样有独立源、可用 Web API
 */
export const MCP_SANDBOX_PRIVILEGES: CustomScheme = {
  scheme: MCP_SANDBOX_SCHEME,
  privileges: { standard: true, secure: true },
};

/** `_meta.ui.csp`（规范 McpUiResourceCsp） */
interface UiResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** 域名条目只放行 `scheme://host[:port]` / 通配子域：拒掉分号、引号、空白，防注入新指令（同 Web） */
const ORIGIN_RE = /^(https?|wss?):\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

function domains(list: unknown): string {
  if (!Array.isArray(list)) return '';
  return list.filter((d): d is string => typeof d === 'string' && ORIGIN_RE.test(d)).join(' ');
}

/** 按声明构造 CSP（拷自 backend buildCsp，改动两边同步）。未声明时外部来源为空 = 规范的限制性默认值 */
export function buildCsp(csp: UiResourceCsp | undefined): string {
  const res = domains(csp?.resourceDomains);
  const connect = domains(csp?.connectDomains);
  const frame = domains(csp?.frameDomains);
  const baseUri = domains(csp?.baseUriDomains);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${res}`,
    `style-src 'self' 'unsafe-inline' blob: data: ${res}`,
    `img-src 'self' data: blob: ${res}`,
    `font-src 'self' data: blob: ${res}`,
    `media-src 'self' data: blob: ${res}`,
    `connect-src 'self' ${connect}`,
    `worker-src 'self' blob: ${res}`,
    frame ? `frame-src ${frame}` : "frame-src 'none'",
    "object-src 'none'",
    baseUri ? `base-uri ${baseUri}` : "base-uri 'self'",
  ]
    .map((d) => d.trim())
    .join('; ');
}

function parseCspParam(raw: string | null): UiResourceCsp | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

const SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>MCP App Sandbox</title>
<style>html,body{margin:0;height:100%;width:100%;background:transparent;overflow:hidden}
body{display:flex;flex-direction:column}
iframe{flex:1;border:0;background:transparent;color-scheme:inherit}</style>
</head><body><script>
(function () {
  if (window.self === window.top) throw new Error('sandbox must be embedded');
  try { window.top.alert('sandbox escaped'); throw 'FAIL'; } catch (e) {
    if (e === 'FAIL') throw new Error('sandbox is not isolated');
  }
  var own = location.origin;
  var PERMS = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' };
  var inner = document.createElement('iframe');
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
  document.body.appendChild(inner);
  window.addEventListener('message', function (ev) {
    var data = ev.data;
    if (ev.source === window.parent) {
      if (data && data.method === 'ui/notifications/sandbox-resource-ready') {
        var p = data.params || {};
        if (typeof p.sandbox === 'string') inner.setAttribute('sandbox', p.sandbox);
        var allow = Object.keys(p.permissions || {}).map(function (k) { return PERMS[k]; }).filter(Boolean);
        if (allow.length) inner.setAttribute('allow', allow.join('; '));
        if (typeof p.html === 'string') {
          var doc = inner.contentDocument;
          if (doc) { doc.open(); doc.write(p.html); doc.close(); } else { inner.srcdoc = p.html; }
        }
        return;
      }
      if (inner.contentWindow) inner.contentWindow.postMessage(data, '*');
    } else if (ev.source === inner.contentWindow) {
      if (ev.origin !== own) return;
      window.parent.postMessage(data, '*');
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
})();
</script></body></html>`;

/** app ready 之后调用：默认 session（主窗口所在）上处理 spark-mcp:// 请求 */
export function handleMcpSandboxProtocol(): void {
  protocol.handle(MCP_SANDBOX_SCHEME, (req) => {
    const url = new URL(req.url);
    if (req.method !== 'GET' || !HOST_RE.test(url.hostname) || url.pathname !== '/') {
      return new Response(null, { status: 404 });
    }
    return new Response(SANDBOX_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': buildCsp(parseCspParam(url.searchParams.get('csp'))),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}
