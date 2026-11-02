import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { previewBase } from '../preview/preview-host';

/**
 * MCP Apps 的 sandbox proxy（规范 §Sandbox proxy：Web 宿主必须套一层与宿主**不同源**的代理 iframe）。
 *
 * 源：每个 MCP server 一个子域名 `m-<hash>.<PREVIEW_PROXY_BASE 的 host>`（设计 Q5），
 * 复用端口预览已有的泛域名基础设施；本地 `*.localhost` 浏览器自动解析到回环，零配置。
 * 不同 server 的 App 互相读不到对方的 localStorage / cookie。
 *
 * 这个源上只有一个页面：外层代理 HTML。它校验嵌入方、建内层 iframe、把宿主发来的 View HTML
 * document.write 进去，并在宿主 ↔ View 之间转发 postMessage。CSP 经 HTTP 头下发（View 无法篡改），
 * 由 `?csp=` 携带的 `_meta.ui.csp` 声明构造；document.write 出的内层文档继承这份 CSP。
 * 其余路径一律 404：CSP 的 'self' 指向这个源，不能让 App 借它摸到后端 API。
 */

/** 子域名 label：m- + 16 位 hex（server id 的 sha256 前缀，不暴露原始 id）。 */
const LABEL_RE = /^m-[a-f0-9]{16}$/;

export function sandboxOrigin(serverId: string, base = previewBase()): string {
  const hash = createHash('sha256').update(serverId).digest('hex').slice(0, 16);
  return `${base.protocol}//m-${hash}.${base.host}`;
}

/** Host 头是否是 MCP sandbox 主机（基域名须完全一致，含端口）。 */
export function isSandboxHost(
  host: string | undefined,
  base = previewBase(),
): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  const suffix = `.${base.host.toLowerCase()}`;
  return h.endsWith(suffix) && LABEL_RE.test(h.slice(0, -suffix.length));
}

/** `_meta.ui.csp`（规范 McpUiResourceCsp）。 */
export interface UiResourceCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * 域名条目只放行 `scheme://host[:port]` / 通配子域这类源表达式：拒掉分号、引号、空白，
 * 防 server 借声明注入新指令或 'unsafe-eval' 之类关键字（规范：不得放宽未声明的来源）。
 */
const ORIGIN_RE = /^(https?|wss?):\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

function domains(list: unknown): string {
  if (!Array.isArray(list)) return '';
  return list
    .filter((d): d is string => typeof d === 'string' && ORIGIN_RE.test(d))
    .join(' ');
}

/**
 * 按声明构造 CSP。未声明（csp 缺省）时各外部来源为空 = 规范要求的限制性默认值：
 * 只允许同源 + 内联脚本样式（打包好的单文件 App 正需要内联），connect 只到 'self'（即本 404 源）。
 */
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

/** 允许嵌入 sandbox 的宿主源：主站（CORS_ORIGIN，可逗号分隔多个）。 */
export function hostOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? 'http://localhost:3100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 外层代理页。逻辑对齐官方 basic-host 示例的 sandbox.ts（ext-apps v1.7.5）：
 * 校验 referrer ∈ 宿主白名单 → 自检确实被隔离（访问 window.top 必须抛 SecurityError）→
 * 建内层 iframe → 收到 sandbox-resource-ready 写入 View HTML，其余消息双向转发（宿主侧锁定源）。
 */
function sandboxHtml(origins: string[]): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>MCP App Sandbox</title>
<style>html,body{margin:0;height:100%;width:100%;background:transparent;overflow:hidden}
body{display:flex;flex-direction:column}
iframe{flex:1;border:0;background:transparent;color-scheme:inherit}</style>
</head><body><script>
(function () {
  var ALLOWED = ${JSON.stringify(origins)};
  if (window.self === window.top) throw new Error('sandbox must be embedded');
  var host = '';
  try { host = new URL(document.referrer).origin; } catch (e) {}
  if (ALLOWED.indexOf(host) < 0) throw new Error('embedding origin not allowed: ' + host);
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
      if (ev.origin !== host) return;
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
      window.parent.postMessage(data, host);
    }
  });
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, host);
})();
</script></body></html>`;
}

/** `?csp=` 的值：base64url(JSON)。解析失败按未声明处理（最严默认）。 */
export function parseCspParam(raw: string | null): UiResourceCsp | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * express 中间件（main.ts 里排在预览反代之后、CORS 之前）：sandbox 主机的请求在这里终结，
 * 不进 Nest 路由 / 鉴权 / 响应包装；其它请求直接 next()。
 */
export function mcpSandboxHttp(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (!isSandboxHost(req.headers.host)) {
    next();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://sandbox');
  if (req.method !== 'GET' || url.pathname !== '/') {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    buildCsp(parseCspParam(url.searchParams.get('csp'))),
  );
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(sandboxHtml(hostOrigins()));
}
