/**
 * 网页预览的「浏览器」逻辑（纯函数，单测见 site-browser.test.ts）：地址栏显示什么、输入的地址怎么解析、
 * 后退 / 前进的历史怎么记。
 *
 * 预览只开两类页面：工作区里的静态页（spark-preview://<工作区>/路径）和本机服务（http://localhost:端口/路径）。
 * 历史是每个标签自己记的一份：多个网页标签的 iframe 共用窗口的会话历史，直接调 history.back()
 * 可能退掉的是另一个标签里的页面，所以后退 / 前进是按这里记的地址重新加载。
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const PREVIEW_SCHEME = 'spark-preview:';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 地址栏里显示的文字：静态页给工作区路径（/site/index.html），本机服务给 localhost:端口/路径 */
export function displayAddress(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const rest = `${safeDecode(u.pathname)}${u.search}${u.hash}`;
  return u.protocol === PREVIEW_SCHEME ? rest : `${u.host}${rest}`;
}

/**
 * 地址栏里输入的内容 → 要加载的地址；不能预览的（外网、别的协议、空）返回 null。
 * - http://localhost:3000/x、localhost:3000/x：本机服务（只认 http 的 localhost / 127.0.0.1）；
 * - /about：当前站点下的路径（静态页是工作区里的路径）；
 * - about.html、../x：相对当前页面。
 */
export function resolveAddress(input: string, currentUrl: string): string | null {
  const raw = input.trim();
  const current = parse(currentUrl);
  if (!raw || !current) return null;
  // 「主机:端口」开头：补上 http://（要先于「带协议」判断——localhost:3000 会被当成协议 localhost:）
  const hostPort = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$|\?|#)/i.test(raw);
  const absolute = hostPort ? `http://${raw}` : /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : null;
  const target = parse(absolute ?? new URL(raw, current).href);
  if (!target) return null;
  if (target.protocol === 'http:') return LOCAL_HOSTS.has(target.hostname) ? target.href : null;
  // 静态页只能在当前这个工作区的源里跳
  if (target.protocol === PREVIEW_SCHEME) return target.host === current.host ? target.href : null;
  return null;
}

/** 一个网页标签的浏览历史：entries[index] 是当前页面 */
export interface SiteHistory {
  entries: string[];
  index: number;
}

export const EMPTY_HISTORY: SiteHistory = { entries: [], index: -1 };

export const currentUrl = (h: SiteHistory): string | null => h.entries[h.index] ?? null;
export const canGoBack = (h: SiteHistory): boolean => h.index > 0;
export const canGoForward = (h: SiteHistory): boolean => h.index < h.entries.length - 1;

/**
 * iframe 里发生了一次导航。
 * settling：这次导航是我们自己发起的加载（首次打开 / 刷新 / 后退前进 / 地址栏回车）落地——
 * 地址和预期不一样说明被重定向了，替换当前这条，不新增（否则后退又回到会重定向的地址，永远退不回去）。
 * 否则是页面里点链接、脚本跳转：新增一条，丢掉它后面的前进记录。地址没变（刷新、重复事件）不动。
 */
export function navigated(h: SiteHistory, url: string, settling: boolean): SiteHistory {
  if (currentUrl(h) === url) return h;
  if (h.index < 0) return { entries: [url], index: 0 };
  if (settling) return { ...h, entries: h.entries.map((e, i) => (i === h.index ? url : e)) };
  return { entries: [...h.entries.slice(0, h.index + 1), url], index: h.index + 1 };
}

/** 地址栏回车 / 外部要求加载某个地址：当成一次新的访问 */
export function visit(h: SiteHistory, url: string): SiteHistory {
  if (currentUrl(h) === url) return h;
  return { entries: [...h.entries.slice(0, h.index + 1), url], index: h.index + 1 };
}

/** 后退 / 前进 delta 步；到头了原样返回 */
export function step(h: SiteHistory, delta: -1 | 1): SiteHistory {
  const index = h.index + delta;
  return index < 0 || index >= h.entries.length ? h : { ...h, index };
}
