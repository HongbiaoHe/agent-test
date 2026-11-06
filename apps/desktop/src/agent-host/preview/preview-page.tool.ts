/**
 * preview_page（desktop 版，名称 / 参数 / 成功结果形状对照 apps/backend/src/agent/tools/preview-page.tool.ts，
 * renderer 的 parsePreviewResult 两端共用同一口径）：让 agent **主动**为用户弹出可交互的网页预览。
 * - 静态页（path=*.html）：工作区里的文件，renderer 经 main 的 spark-preview:// 协议加载（工作区根即站点根）；
 * - 端口（port）：本机运行中的 web 服务，renderer 直接 iframe http://localhost:端口。
 *
 * 工具本身不渲染：只校验（文件在工作区内且存在 / 端口在本机监听），成功返回 `{ status:'opened', ... }`，
 * renderer 在这个工具的 tool_end 上实时弹出预览并在消息流留卡片。
 *
 * 与 Web 的差异：服务就在本机，不要求监听 0.0.0.0；dev server 刚用 run_in_background 拉起时端口还没就绪，
 * 所以端口探测会等一小会儿（默认最多 20 秒）。
 */
import { stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { resolveInside } from '../workspace/files';

export const PREVIEW_PAGE_TOOL = 'preview_page';

const schema = z.object({
  path: z
    .string()
    .max(1024)
    .optional()
    .describe('静态页：入口 HTML 的路径（工作区内的绝对路径或相对路径）。端口预览：应用内路径（如 /dashboard），缺省 /'),
  port: z.number().int().optional().describe('端口预览：本机正在运行的 web 服务端口（如 vite 的 5173）'),
  title: z.string().max(80).optional().describe('预览窗口标题（简短描述这个页面），缺省用文件名或端口'),
});

type Args = z.infer<typeof schema>;

export interface PreviewPageOptions {
  workspaceDir: string;
  /** 端口没在监听时最多等多久（ms）；单测传小值 */
  portWaitMs?: number;
}

const DEFAULT_PORT_WAIT_MS = 20_000;
const PROBE_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;

/** 连一下 host:port，能建立 TCP 连接就算在监听 */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** localhost 可能解析成 127.0.0.1 或 ::1（vite 默认只监听其一），两个都试 */
async function isListening(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([canConnect('127.0.0.1', port), canConnect('::1', port)]);
  return v4 || v6;
}

async function waitForPort(port: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await isListening(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
}

async function previewPort(args: Args, port: number, waitMs: number) {
  if (port < 1 || port > 65535) return { error: `端口 ${port} 不可预览（须在 1-65535 之间）` };
  const path = args.path?.trim() || '/';
  if (!path.startsWith('/')) return { error: '端口预览的 path 必须以 / 开头' };
  if (!(await waitForPort(port, waitMs))) {
    return {
      error: `端口 ${port} 上没有服务在监听`,
      hint: '先用 run_in_background 在后台启动服务（如 npx vite --port 5173），确认启动成功后再调用 preview_page',
    };
  }
  return { port, path, title: args.title?.trim() || `localhost:${port}`, status: 'opened' };
}

async function previewFile(args: Args, workspaceDir: string) {
  const given = (args.path ?? '').trim();
  if (!/\.html?$/i.test(given)) {
    return { error: '静态页预览只能是 .html / .htm 文件；预览运行中的服务请传 port' };
  }
  let abs: string;
  let root: string;
  try {
    // 绝对路径先换成工作区相对路径；resolveInside 再按真实路径（含软链）确认没出域
    const rel = isAbsolute(given) ? relative(workspaceDir, given) : given;
    abs = await resolveInside(workspaceDir, rel);
    root = await resolveInside(workspaceDir, '');
  } catch (e) {
    const missing = e instanceof Error && 'code' in e && e.code === 'ENOENT';
    return missing
      ? { error: `文件不存在：${given}`, hint: '先用 write_file 写出页面再调用 preview_page' }
      : { error: `路径不在工作区内：${given}（页面须写在工作区里）` };
  }
  if (!(await stat(abs)).isFile()) return { error: `不是文件：${given}` };
  const rel = relative(root, abs).split(sep).join('/');
  return { path: rel, title: args.title?.trim() || rel.split('/').pop(), status: 'opened' };
}

export function createPreviewPageTool(opts: PreviewPageOptions) {
  const waitMs = opts.portWaitMs ?? DEFAULT_PORT_WAIT_MS;
  return tool(
    async (args: Args) =>
      JSON.stringify(
        args.port !== undefined ? await previewPort(args, args.port, waitMs) : await previewFile(args, opts.workspaceDir),
      ),
    {
      name: PREVIEW_PAGE_TOOL,
      description:
        '在用户界面弹出可交互的网页预览窗口。两种用法：\n' +
        '1) 静态页：传 path（入口 .html，工作区内）。工作区根目录就是站点根，资源优先用相对路径（./app.js、css/style.css）；外部 CDN 资源可直接引用。\n' +
        '2) 运行中的服务：传 port（可选 path 指定应用内路径）。适合 vite / React / Vue 等需要构建或 dev server 的项目，' +
        '以及 node / python 后端服务。服务须先用 run_in_background 在后台启动；刚启动还没就绪时本工具会等最多约 20 秒。\n' +
        '**何时用**：写完或改完网页、可视化、小游戏、交互演示、前端应用后，主动调用让用户立刻看到并操作效果；' +
        '改完静态页再调一次即可刷新（dev server 有热更新则无需再调）。\n' +
        '**何时不用**：文件还没写出来 / 服务还没启动。调用后不必再贴完整代码，简要说明页面内容与怎么操作即可。',
      schema,
    },
  );
}
