/**
 * 工作区静态网页预览的源：`spark-preview://w-<hash>/<工作区相对路径>`（agent 的 preview_page 静态页、
 * 工作区面板与对话里的 .html 链接都走它）。
 *
 * - 每个工作区一个独立源（hash 取自工作区真实路径，重启后不变）：与 renderer（file:// 或 dev server）不同源，
 *   预览页拿不到主窗口的 window.desktop / 存储；同一工作区的页面共用自己的 localStorage 等存储；
 * - 工作区根就是站点根，路径一律 realpath 后确认仍在工作区内（防 ../ 与软链出域）；
 * - 只认 renderer 经 IPC 登记过的工作区（siteOrigin），其余主机名一律 404；
 * - 文件交给 net.fetch(file://) 读：Content-Type / Range 由 Chromium 的文件加载器处理；no-store 让刷新拿到最新文件。
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { type CustomScheme, net, protocol } from 'electron';
import { resolveInside } from '../agent-host/workspace/files';
import { mainI18n } from './i18n';

const SCHEME = 'spark-preview';

/** 必须在 app ready 之前与其它特权协议一起注册（registerSchemesAsPrivileged 只能调一次） */
export const SITE_PREVIEW_PRIVILEGES: CustomScheme = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

/** 主机名 → 工作区真实路径 */
const roots = new Map<string, string>();

/** 登记工作区并返回它的预览源（同一工作区总是同一个源） */
export async function siteOrigin(workspaceDir: string): Promise<string> {
  const root = await resolveInside(workspaceDir, '');
  if (!(await stat(root)).isDirectory()) throw new Error(mainI18n.t('errors.workspace.notDirectory', { dir: workspaceDir }));
  const host = `w-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
  roots.set(host, root);
  return `${SCHEME}://${host}`;
}

const notFound = () => new Response('Not found', { status: 404 });

/** app ready 之后调用：默认 session（主窗口所在）上处理 spark-preview:// 请求 */
export function handleSitePreviewProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    const root = roots.get(url.hostname);
    if (!root || (req.method !== 'GET' && req.method !== 'HEAD')) return notFound();
    try {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let abs = await resolveInside(root, rel);
      if ((await stat(abs)).isDirectory()) {
        // 目录：补上结尾的 / 再给 index.html，页面里的相对路径才按这个目录解析
        if (!url.pathname.endsWith('/')) {
          return new Response(null, { status: 301, headers: { Location: `${url.pathname}/${url.search}` } });
        }
        abs = await resolveInside(root, `${rel}/index.html`);
      }
      const res = await net.fetch(pathToFileURL(abs).toString(), { method: req.method, headers: req.headers });
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers });
    } catch {
      // 不存在 / 出域 / 路径解码失败
      return notFound();
    }
  });
}
