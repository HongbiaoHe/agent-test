/**
 * 链接预览（真实模型）：让 agent 原样输出一段带链接的 Markdown，逐个点开——
 * 远程图片 / 远程 md / 工作区 md 在全屏弹窗里看，点蒙层 / 关闭按钮 / Esc 都能关，关完仍停在对话里；
 * 普通网页链接交给系统浏览器（这里把 openExternal 换成记录）；窗口本身不会被导航带走。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { apiKey, launch, newChat, saveGoogleKey, screens, sendAndWait, tempDirs } from './helpers';

const dirs = tempDirs('viewer');

/** 生成一张 240×160 的纯色 PNG（不依赖外部素材） */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function startServer(): Promise<Server> {
  const image = png(240, 160);
  const http = createServer((req, res) => {
    if (req.url === '/cat.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(image);
    } else if (req.url === '/doc.md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }).end('# 远程文档标题\n\n- 第一条\n- 第二条\n');
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(http)));
}

const viewer = (page: Page) => page.getByTestId('file-viewer');

async function expectStillInChat(page: Page) {
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', /^chat:/);
  await expect(page.getByLabel('消息')).toBeVisible();
}

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('对话里的链接：全屏预览图片 / 远程 md / 工作区 md，三种方式关闭，窗口不被带走', async () => {
  mkdirSync(dirs.workspace, { recursive: true });
  writeFileSync(join(dirs.workspace, 'notes.md'), '# 本地笔记标题\n\n工作区里的文件。\n');
  const server = await startServer();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { app, page } = await launch(dirs);
  // 外链：记录下来，不真的打开系统浏览器
  await app.evaluate(({ ipcMain }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { __opened: opened });
    ipcMain.removeHandler('desktop:openExternal');
    ipcMain.handle('desktop:openExternal', (_e, url: string) => {
      opened.push(url);
    });
  });
  await saveGoogleKey(page);
  await newChat(page);
  await sendAndWait(
    page,
    [
      '请原样输出下面这段 Markdown，不要改动、不要放进代码块、不要加任何别的文字，也不要调用工具：',
      '',
      `[看图](${base}/cat.png)`,
      '',
      `[远程文档](${base}/doc.md)`,
      '',
      '[本地笔记](notes.md)',
      '',
      '[官网](https://example.com/)',
      '',
      `![内嵌图](${base}/cat.png)`,
    ].join('\n'),
  );
  const timeline = page.getByTestId('timeline');

  // 1) 远程图片链接 → 全屏看图；点蒙层关闭
  await timeline.getByRole('link', { name: '看图' }).click();
  await expect(viewer(page)).toBeVisible();
  const img = viewer(page).locator('img');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(240);
  await page.screenshot({ path: join(screens, '21-viewer-image.png') });
  const box = await page.getByTestId('file-viewer-backdrop').boundingBox();
  if (!box) throw new Error('预览蒙层不可见');
  await page.mouse.click(box.x + 20, box.y + box.height - 20); // 图片外的空白处
  await expect(viewer(page)).toBeHidden();
  await expectStillInChat(page);

  // 2) 远程 md → 渲染成 Markdown；点关闭按钮
  await timeline.getByRole('link', { name: '远程文档' }).click();
  await expect(viewer(page).getByRole('heading', { name: '远程文档标题' })).toBeVisible();
  await expect(viewer(page).getByRole('listitem')).toHaveCount(2);
  await page.screenshot({ path: join(screens, '22-viewer-markdown.png') });
  await viewer(page).getByRole('button', { name: '关闭预览' }).click();
  await expect(viewer(page)).toBeHidden();

  // 3) 工作区相对路径 → 读工作区文件；Esc 关闭
  await timeline.getByRole('link', { name: '本地笔记' }).click();
  await expect(viewer(page).getByRole('heading', { name: '本地笔记标题' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();

  // 4) Markdown 里的内嵌图片：点开看大图
  await timeline.getByRole('img', { name: '内嵌图' }).click();
  await expect(viewer(page).locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toBeHidden();

  // 5) 普通网页链接 → 交给系统浏览器，不开弹窗、窗口不跳
  await timeline.getByRole('link', { name: '官网' }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual(['https://example.com/']);
  await expect(viewer(page)).toBeHidden();
  await expectStillInChat(page);

  // 6) 兜底：任何让窗口导航走的尝试都被拦下。放在页面内一次 evaluate 里判断——
  // 真跳走了页面上下文会销毁（evaluate 直接抛错）；被拦下则 500ms 后还在对话视图。
  // （被 will-navigate 拦下的导航 Playwright 会一直当作「进行中」，之后的 locator 会卡住，所以这一步放最后）
  const before = page.url();
  const view = await page.evaluate(async () => {
    window.location.href = 'file:///etc/hosts';
    await new Promise((r) => setTimeout(r, 500));
    return { href: window.location.href, view: document.querySelector('main[data-view]')?.getAttribute('data-view') };
  });
  expect(view.href).toBe(before);
  expect(view.view).toMatch(/^chat:/);
  // 对照：摘掉 will-navigate 监听后同样的操作真的会跳走（证明上面拦住的是我们的兜底，而不是 Chromium 本身）
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.removeAllListeners('will-navigate');
  });
  await page.evaluate(() => {
    window.location.href = 'file:///etc/hosts';
  });
  await expect.poll(() => page.url(), { timeout: 10_000 }).toBe('file:///etc/hosts');

  await app.close();
  server.close();
});
