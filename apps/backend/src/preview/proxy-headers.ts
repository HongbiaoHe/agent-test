import type { IncomingHttpHeaders } from 'node:http';

/**
 * 反代的请求/响应头改写（纯逻辑，独立文件便于单测）。
 */

/** 逐跳头（RFC 9110 §7.6.1）+ 由我们重新决定的头：不能原样转发。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function flatten(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * 浏览器 → 上游的 HTTP 请求头：去掉逐跳头，再叠上提供方要求的访问头（令牌只在服务端出现）。
 * 访问头最后写入，浏览器无法用同名头覆盖。
 */
export function upstreamRequestHeaders(
  incoming: IncomingHttpHeaders,
  access: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // 浏览器带来的同名访问头丢弃（大小写不同也算同名，否则 fetch 会把两个值拼成一个）
  const accessKeys = new Set(Object.keys(access).map((a) => a.toLowerCase()));
  for (const [k, v] of Object.entries(incoming)) {
    const value = flatten(v);
    const key = k.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key) || accessKeys.has(key)) {
      continue;
    }
    out[k] = value;
  }
  for (const [k, v] of Object.entries(access)) out[k] = v;
  return out;
}

/**
 * WebSocket 升级请求头：与 HTTP 相反，Upgrade / Connection / Sec-WebSocket-* 必须保留，
 * Host 改成上游主机（提供方按 Host 路由到具体沙箱端口）。
 */
export function upgradeRequestHeaders(
  incoming: IncomingHttpHeaders,
  upstreamHost: string,
  access: Record<string, string>,
): [string, string][] {
  const out: [string, string][] = [['Host', upstreamHost]];
  // 浏览器带来的同名访问头一律丢弃，只认服务端注入的
  const accessKeys = new Set(Object.keys(access).map((a) => a.toLowerCase()));
  for (const [k, v] of Object.entries(incoming)) {
    const value = flatten(v);
    const key = k.toLowerCase();
    if (value === undefined || key === 'host' || accessKeys.has(key)) continue;
    out.push([k, value]);
  }
  for (const [k, v] of Object.entries(access)) out.push([k, v]);
  return out;
}

/** 响应侧不转发的逐跳头（由 Node 自己管理）；正文原样透传，编码与长度保持不变。 */
const DROP_RESPONSE = new Set([
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/**
 * 上游 → 浏览器的响应头。
 * - Location 指回上游源时改成相对路径，否则重定向会把浏览器直接带去提供方域名（缺令牌头 → 403）。
 * - Set-Cookie 去掉 Domain：上游域名下的 cookie 对预览主机无效，去掉后落在预览主机自己身上。
 * - Referrer-Policy 强制 no-referrer：预览地址本身就是访问凭证，不能经 Referer 泄露给页面加载的外部资源。
 */
export function downstreamResponseHeaders(
  headers: IncomingHttpHeaders,
  upstreamOrigin: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (
      v === undefined ||
      DROP_RESPONSE.has(key) ||
      key === 'referrer-policy'
    ) {
      continue;
    }
    if (key === 'set-cookie') {
      const list = Array.isArray(v) ? v : [v];
      out[k] = list.map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
      continue;
    }
    if (
      key === 'location' &&
      typeof v === 'string' &&
      v.startsWith(upstreamOrigin)
    ) {
      out[k] = v.slice(upstreamOrigin.length) || '/';
      continue;
    }
    out[k] = v;
  }
  out['referrer-policy'] = 'no-referrer';
  return out;
}
