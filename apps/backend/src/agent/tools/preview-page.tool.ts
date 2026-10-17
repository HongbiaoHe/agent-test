import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { isPreviewablePort } from '../../preview/preview-ports';
import type { GuardedSandbox } from '../guarded-sandbox';

/**
 * 静态页确认入口存在用 downloadFiles、解析路径用 toWorkspaceRelative，端口探测用 execute
 * （测试时可注入假实现）。
 */
export type PreviewSandbox = Pick<
  GuardedSandbox,
  'downloadFiles' | 'execute' | 'toWorkspaceRelative'
>;

const schema = z.object({
  path: z
    .string()
    .max(1024)
    .optional()
    .describe(
      '静态页：入口 HTML 的路径，如 /workspace/todo-app/index.html。' +
        '端口预览：应用内路径（如 /dashboard），缺省 /',
    ),
  port: z
    .number()
    .int()
    .optional()
    .describe('端口预览：沙箱里正在运行的 web 服务端口（如 vite 的 5173）'),
  title: z
    .string()
    .max(80)
    .optional()
    .describe('预览窗口标题（简短描述这个页面），缺省用文件名或端口'),
});

type Args = z.infer<typeof schema>;

/** 探测结果标记：服务对外网卡可达 / 只监听回环 / 没有监听。 */
const PORT_OPEN = 'PREVIEW_PORT_OPEN';
const PORT_LOOPBACK = 'PREVIEW_PORT_LOOPBACK';
const PORT_CLOSED = 'PREVIEW_PORT_CLOSED';

/**
 * 提供方的端口代理从沙箱外部连进来，服务必须监听 0.0.0.0——只监听 127.0.0.1（vite 默认）
 * 时外面连不上。所以先连对外网卡地址，连不上再试回环，区分「没起来」和「没对外监听」。
 * 用 bash 的 /dev/tcp（不依赖 curl/nc）；拿不到网卡地址时只能确认回环，按可达放行。
 */
function probeScript(port: number): string {
  const p = String(port);
  return (
    `bash -c 'ip=$(hostname -I 2>/dev/null | cut -d" " -f1); ` +
    `if [ -n "$ip" ]; then ` +
    `(exec 3<>/dev/tcp/$ip/${p}) 2>/dev/null && echo ${PORT_OPEN} && exit 0; ` +
    `(exec 3<>/dev/tcp/127.0.0.1/${p}) 2>/dev/null && echo ${PORT_LOOPBACK} && exit 0; ` +
    `else (exec 3<>/dev/tcp/127.0.0.1/${p}) 2>/dev/null && echo ${PORT_OPEN} && exit 0; fi; ` +
    `echo ${PORT_CLOSED}'`
  );
}

async function previewPort(sb: PreviewSandbox, args: Args, port: number) {
  if (!isPreviewablePort(port)) {
    return {
      error: `端口 ${port} 不可预览（超出 1-65535 或为沙箱提供方保留端口）`,
    };
  }
  const path = args.path?.trim() || '/';
  if (!path.startsWith('/')) return { error: '端口预览的 path 必须以 / 开头' };
  const { output } = await sb.execute(probeScript(port));
  if (output.includes(PORT_CLOSED)) {
    return {
      error: `端口 ${port} 上没有服务在监听`,
      hint: '先用 execute 在后台启动服务（如 nohup npm run dev -- --host 0.0.0.0 > dev.log 2>&1 &），确认启动成功后再调用 preview_page',
    };
  }
  if (output.includes(PORT_LOOPBACK)) {
    return {
      error: `端口 ${port} 只监听了 127.0.0.1，沙箱外部访问不到`,
      hint: '让服务监听 0.0.0.0 后重启（vite 加 --host 0.0.0.0；node 的 listen(port, "0.0.0.0")；python -m http.server 默认即可）',
    };
  }
  // 探测不到任何标记（如没有 bash）：无法确认，按可达放行，加载失败时弹窗里会提示
  return {
    port,
    path,
    title: args.title?.trim() || `localhost:${port}`,
    status: 'opened',
  };
}

async function previewFile(sb: PreviewSandbox, args: Args) {
  const given = (args.path ?? '').trim();
  if (!/\.html?$/i.test(given)) {
    return {
      error: '静态页预览只能是 .html / .htm 文件；预览运行中的服务请传 port',
    };
  }
  // 工作区相对路径（预览接口按它签发地址）；工作区外的绝对路径 / ../ 逃逸 → null
  const rel = sb.toWorkspaceRelative(given);
  if (!rel) {
    return { error: `路径不在工作区内：${given}（页面须写在工作区里）` };
  }
  const [res] = await sb.downloadFiles([rel]);
  if (!res || res.error || !res.content) {
    return {
      error: `文件不存在：${given}`,
      hint: '先用 write_file 写出页面再调用 preview_page',
    };
  }
  return {
    path: rel,
    title: args.title?.trim() || rel.split('/').pop(),
    status: 'opened',
  };
}

/**
 * preview_page：让 agent **主动**为用户弹出可交互的网页预览。两种形态：
 * - 静态页（path=*.html）：工作区文件经预览子域名直接读取（文件会话）；
 * - 端口（port）：沙箱里运行中的 web 服务经子域名反代（见 preview 模块），支持 vite HMR。
 *
 * 工具本身不渲染任何东西：只做校验（文件存在 / 端口在对外监听），成功返回
 * `{ status:'opened', ... }`。前端在这个工具的 tool_end 上实时弹出预览并在消息流留卡片
 * （与 generate_image → 媒体卡片同一模式，历史回放也成立）。预览地址由前端打开时现签，不落库。
 *
 * 仅在有沙箱时注入（无沙箱就没有工作区文件和服务可预览）。
 */
export function createPreviewPageTool(sb: PreviewSandbox) {
  return tool(
    async (args: Args) =>
      JSON.stringify(
        args.port !== undefined
          ? await previewPort(sb, args, args.port)
          : await previewFile(sb, args),
      ),
    {
      name: 'preview_page',
      description:
        '在用户界面弹出可交互的网页预览窗口。两种用法：\n' +
        '1) 静态页：传 path（入口 .html）。入口所在目录就是站点根——资源用相对路径放在同目录或子目录' +
        '（./app.js、css/style.css），不要用 ../ 或以 / 开头的绝对路径；外部 CDN 资源可直接引用。\n' +
        '2) 运行中的服务：传 port（可选 path 指定应用内路径）。适合 vite / React / Vue 等需要构建或 dev server 的项目，' +
        '以及 node / python 后端服务。服务必须**后台运行**并**监听 0.0.0.0**' +
        '（如 nohup npx vite --host 0.0.0.0 --port 5173 > vite.log 2>&1 &）；vite 还需在配置里设 server.allowedHosts: true。\n' +
        '**何时用**：写完或改完网页、可视化、小游戏、交互演示、前端应用后，主动调用让用户立刻看到并操作效果；' +
        '改完静态页再调一次即可刷新（dev server 有热更新则无需再调）。\n' +
        '**何时不用**：文件还没写出来 / 服务还没启动成功。调用后不必再贴完整代码，简要说明页面内容与怎么操作即可。',
      schema,
    },
  );
}
