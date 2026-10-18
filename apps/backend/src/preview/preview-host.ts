/**
 * 端口预览的主机名约定（纯逻辑，独立文件便于单测）。
 *
 * 每个预览会话一个独立子域名：`p-<id>.<基域名>`。用子域名而不是路径前缀，是因为 vite 等
 * dev server 产出大量以 `/` 开头的绝对路径（/@vite/client、/src/main.ts）和同源 HMR
 * websocket——只有让预览站点独占一个源，它们才能原样工作。独立源也让预览页与主站天然隔离。
 *
 * 基域名由 PREVIEW_PROXY_BASE 指定（含协议），缺省 `http://localhost:<PORT>`：浏览器把
 * `*.localhost` 解析到回环地址，本地开发零配置。生产需要泛域名解析 + 泛域名证书，例如
 * PREVIEW_PROXY_BASE=https://preview.example.com（最好与主站不同的可注册域名，彻底跨站）。
 */

/** 会话 id：128 位随机数的 hex（32 个小写字符，满足 DNS label ≤ 63）。 */
const ID_RE = /^[a-f0-9]{32}$/;

export function previewBase(): URL {
  return new URL(
    process.env.PREVIEW_PROXY_BASE ??
      `http://localhost:${process.env.PORT ?? 3101}`,
  );
}

/** 会话 id → 预览站点地址（含末尾 /，调用方再拼应用内路径）。 */
export function previewOrigin(id: string, base = previewBase()): string {
  return `${base.protocol}//p-${id}.${base.host}`;
}

/**
 * 请求的 Host 头 → 会话 id；不是预览主机返回 null（请求交还给正常路由）。
 * 基域名必须完全一致（含端口），防止 `p-<id>.evil.com` 之类的 Host 被当成预览请求。
 */
export function parsePreviewHost(
  host: string | undefined,
  base = previewBase(),
): string | null {
  if (!host) return null;
  const h = host.toLowerCase();
  const suffix = `.${base.host.toLowerCase()}`;
  if (!h.startsWith('p-') || !h.endsWith(suffix)) return null;
  const id = h.slice(2, h.length - suffix.length);
  return ID_RE.test(id) ? id : null;
}

/**
 * 预览域名与主站是否同站（共享可注册域名）。同站时，主站若有 `Domain=.example.com` 的 cookie，
 * agent 写的预览页就能读到、甚至改写它（cookie tossing）——预览必须放在**另一个**可注册域名下。
 * 用「主机名最后两段」近似可注册域名：不引入公共后缀列表；对 co.uk 这类二级后缀会多报（只多报不漏报）。
 * 本地 localhost / IP 不判：浏览器对它们的 cookie 只认确切主机，没有父域共享问题。
 */
export function sharesSiteWithMain(
  previewBase: URL,
  mainOrigin: string | undefined,
): boolean {
  if (!mainOrigin) return false;
  let main: URL;
  try {
    main = new URL(mainOrigin);
  } catch {
    return false;
  }
  const site = (h: string) => h.toLowerCase().split('.').slice(-2).join('.');
  const local = (h: string) =>
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^[\d.]+$/.test(h) ||
    h.includes(':');
  if (local(previewBase.hostname) || local(main.hostname)) return false;
  return site(previewBase.hostname) === site(main.hostname);
}
