import { GuardedSandbox } from '../guarded-sandbox';
import type { GuardableSandbox } from '../sandbox-providers';
import {
  createPreviewPageTool,
  type PreviewSandbox,
} from './preview-page.tool';

/** 路径规则用真的 GuardedSandbox（toWorkspaceRelative 不碰 inner）：工作区 = /workspace */
const paths = new GuardedSandbox(
  {} as unknown as GuardableSandbox,
  '/home/user/agent-workspace',
  '/workspace',
);

/** 假沙箱：只认 existing 里的路径；端口探测输出由 probeOutput 决定。 */
function fakeSandbox(existing: string[], probeOutput = '') {
  const downloadFiles = jest.fn((paths: string[]) =>
    Promise.resolve(
      paths.map((p) =>
        existing.includes(p)
          ? { path: p, content: new Uint8Array([1]), error: null }
          : { path: p, content: null, error: 'file_not_found' as const },
      ),
    ),
  );
  const execute = jest.fn(() =>
    Promise.resolve({ output: probeOutput, exitCode: 0, truncated: false }),
  );
  return {
    sb: {
      downloadFiles,
      execute,
      toWorkspaceRelative: (p: string) => paths.toWorkspaceRelative(p),
    } as unknown as PreviewSandbox,
    downloadFiles,
    execute,
  };
}

async function call(
  sb: PreviewSandbox,
  args: { path?: string; port?: number; title?: string },
) {
  const out: unknown = await createPreviewPageTool(sb).invoke(args);
  return JSON.parse(String(out)) as Record<string, unknown>;
}

describe('preview_page 工具', () => {
  it('入口存在 → 返回工作区相对路径与标题（前端据此签发预览地址）', async () => {
    const { sb, downloadFiles } = fakeSandbox(['todo/index.html']);
    expect(
      await call(sb, { path: '/workspace/todo/index.html', title: '待办清单' }),
    ).toEqual({ path: 'todo/index.html', title: '待办清单', status: 'opened' });
    expect(downloadFiles).toHaveBeenCalledWith(['todo/index.html']);
  });

  it('工作区外的绝对路径（含旧约定的 /todo/index.html）→ 拒绝且不碰沙箱', async () => {
    const { sb, downloadFiles } = fakeSandbox(['todo/index.html']);
    const r = await call(sb, { path: '/todo/index.html' });
    expect(r.error).toContain('不在工作区内');
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  it('不给标题 → 用文件名', async () => {
    const { sb } = fakeSandbox(['a/page.htm']);
    expect((await call(sb, { path: 'a/page.htm' })).title).toBe('page.htm');
  });

  it('文件不存在 → 返回错误提示让模型先写文件，而不是让前端弹一个 404 窗口', async () => {
    const { sb } = fakeSandbox([]);
    const r = await call(sb, { path: '/workspace/x/index.html' });
    expect(r.error).toContain('/workspace/x/index.html');
    expect(r).not.toHaveProperty('status');
  });

  it('非 HTML / 含 .. → 拒绝且不碰沙箱', async () => {
    const { sb, downloadFiles } = fakeSandbox(['a.js']);
    expect((await call(sb, { path: '/a.js' })).error).toBeDefined();
    expect((await call(sb, { path: '../etc/index.html' })).error).toBeDefined();
    expect(downloadFiles).not.toHaveBeenCalled();
  });

  describe('端口预览', () => {
    it('服务对外监听 → 返回端口、应用内路径与标题；不碰文件下载', async () => {
      const { sb, downloadFiles, execute } = fakeSandbox(
        [],
        'PREVIEW_PORT_OPEN\n',
      );
      expect(
        await call(sb, { port: 5173, path: '/about', title: 'Vite 计数器' }),
      ).toEqual({
        port: 5173,
        path: '/about',
        title: 'Vite 计数器',
        status: 'opened',
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(String(execute.mock.calls[0])).toContain('/dev/tcp');
      expect(downloadFiles).not.toHaveBeenCalled();
    });

    it('缺省 path=/、标题用 localhost:端口', async () => {
      const { sb } = fakeSandbox([], 'PREVIEW_PORT_OPEN');
      expect(await call(sb, { port: 3000 })).toMatchObject({
        path: '/',
        title: 'localhost:3000',
      });
    });

    it('没有服务在监听 → 错误 + 让模型先后台启动', async () => {
      const { sb } = fakeSandbox([], 'PREVIEW_PORT_CLOSED');
      const r = await call(sb, { port: 5173 });
      expect(r.error).toContain('没有服务');
      expect(String(r.hint)).toContain('0.0.0.0');
      expect(r).not.toHaveProperty('status');
    });

    it('只监听 127.0.0.1（vite 默认）→ 错误 + 提示改监听 0.0.0.0', async () => {
      const { sb } = fakeSandbox([], 'PREVIEW_PORT_LOOPBACK');
      const r = await call(sb, { port: 5173 });
      expect(r.error).toContain('127.0.0.1');
      expect(String(r.hint)).toContain('--host 0.0.0.0');
    });

    it('提供方保留端口 / 越界端口 → 拒绝且不探测', async () => {
      const { sb, execute } = fakeSandbox([], 'PREVIEW_PORT_OPEN');
      expect((await call(sb, { port: 49983 })).error).toBeDefined();
      expect((await call(sb, { port: 70000 })).error).toBeDefined();
      expect(execute).not.toHaveBeenCalled();
    });

    it('探测不出任何标记（如沙箱没有 bash）→ 无法确认，按可达放行', async () => {
      const { sb } = fakeSandbox([], 'sh: bash: not found');
      expect((await call(sb, { port: 8080 })).status).toBe('opened');
    });
  });
});
