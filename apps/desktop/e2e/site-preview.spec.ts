/**
 * 网页预览（真实模型）：
 * 1) agent 写静态页后调 preview_page → 弹窗自动打开，iframe 里页面可交互、相对路径的样式能加载；关掉后从消息流卡片再开；
 * 2) 工作区面板里选中 .html → 「Preview page」按钮打开同一个弹窗（不需要模型，单独一个用例）；
 * 3) agent 对已在运行的本机服务调 preview_page（带应用内 path）→ 端口预览；
 * 4) 对话里的本机服务链接 / 工作区 .html 链接 → 在应用内预览，不交给系统浏览器；
 * 5) agent 用 run_in_background 拉起服务后紧接着 preview_page（工具会等端口就绪）。
 *
 * 跑法同其它真实模型用例（SPARK_E2E_GOOGLE_API_KEY）。不能拷本机 Spark 的 secrets.json 复用 Key：
 * Playwright 拉起的 Electron 用的是模拟钥匙串，safeStorage 解不开真实应用加密的密文（实测立即报解密失败）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiKey, launch, newChat, saveGoogleKey, screens, sendAndWait, setPermission, tempDirs } from './helpers';

const dirs = tempDirs('site-preview');

function startServer(): Promise<Server> {
  const http = createServer((req, res) => {
    const body =
      req.url === '/about'
        ? '<!doctype html><title>about</title><h1>关于页</h1>'
        : // 不设背景色：看 iframe 在深色主题下是否仍铺上页面自己的白色画布
          '<!doctype html><title>home</title><h1>本机服务首页</h1><p>没有设置背景色的页面</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(http)));
}

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

// 网页预览开在对话右侧的侧栏里（不再是全屏弹窗）
// 侧栏是带标签的容器：别的标签里的网页还挂着（只是隐藏），所以只认当前标签里的那个
const viewer = (page: Page) =>
  page.locator('[data-testid="side-tab-panel"][data-active="true"]').getByTestId('site-pane');
const frame = (page: Page) => viewer(page).locator('iframe').contentFrame();

/** 收起右侧侧栏（标签都留着），等网页预览不再可见 */
async function closeSidePanel(page: Page): Promise<void> {
  await page.getByTestId('chat-side-panel').getByRole('button', { name: '关闭侧栏' }).click();
  await expect(viewer(page)).toBeHidden();
}

test('工作区面板：.html 以网页打开（相对路径资源、交互、刷新、深色主题下的画布），不需要模型', async () => {
  const ws = join(dirs.root, 'panel-workspace');
  mkdirSync(join(ws, 'site', 'css'), { recursive: true });
  writeFileSync(
    join(ws, 'site', 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="css/style.css">' +
      '<script>let n = 0;</script>' +
      '<h1>面板预览</h1><button onclick="document.getElementById(\'c\').textContent = ++n">加一</button><span id="c">0</span>' +
      '<p><a href="other.html">去第二页</a></p>',
  );
  writeFileSync(join(ws, 'site', 'other.html'), '<!doctype html><meta charset="utf-8"><h1>第二页</h1>');
  writeFileSync(join(ws, 'site', 'css', 'style.css'), 'h1 { color: rgb(200, 30, 30); }');
  const { app, page } = await launch({ userData: join(dirs.root, 'panel-user-data'), workspace: ws });
  // 诊断：记录预览 iframe 的每次导航与点击时刻。这条用例在整套里偶发「点了加一计数仍为 0」，
  // 单独跑复现不了；失败时据此判断是否点击后 iframe 又被重载（计数被重置）
  const t0 = Date.now();
  const nav: string[] = [];
  page.on('framenavigated', (f) => {
    if (f.url().startsWith('spark-preview://')) nav.push(`nav@${Date.now() - t0}`);
  });
  try {
    await newChat(page);
    await page.getByRole('button', { name: '工作区文件', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'site' }).click();
    await sheet.getByRole('button', { name: 'index.html' }).click();
    await sheet.getByRole('button', { name: '预览网页' }).click();
    const heading = frame(page).getByRole('heading', { name: '面板预览' });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS('color', 'rgb(200, 30, 30)');
    // 浏览器式的工具栏：地址栏显示工作区里的路径；刚打开没有可后退 / 前进的
    const address = viewer(page).getByRole('textbox', { name: '地址' });
    const back = viewer(page).getByRole('button', { name: '后退' });
    const forward = viewer(page).getByRole('button', { name: '前进' });
    await expect(address).toHaveValue('/site/index.html');
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();
    expect(await viewer(page).locator('iframe').getAttribute('src')).toMatch(/^spark-preview:\/\/w-[a-f0-9]{16}\/site\/index\.html$/);
    nav.push(`click@${Date.now() - t0}`);
    await frame(page).getByRole('button', { name: '加一' }).click();
    await expect(frame(page).locator('#c'), `iframe 导航与点击时序：${nav.join(' ')}`).toHaveText('1');
    // 刷新：iframe 重新加载；改过的文件也立即生效（no-store）
    writeFileSync(join(ws, 'site', 'css', 'style.css'), 'h1 { color: rgb(30, 30, 200); }');
    await viewer(page).getByRole('button', { name: '刷新' }).click();
    await expect(frame(page).locator('#c')).toHaveText('0');
    await expect(heading).toHaveCSS('color', 'rgb(30, 30, 200)');
    // 页面里点链接：地址栏跟着变，可以后退；后退 / 前进回到对应的页面
    await frame(page).getByRole('link', { name: '去第二页' }).click();
    await expect(frame(page).getByRole('heading', { name: '第二页' })).toBeVisible();
    await expect(address).toHaveValue('/site/other.html');
    await expect(back).toBeEnabled();
    await page.screenshot({ path: join(screens, '50b-site-browser-second-page.png') });
    await back.click();
    await expect(heading).toBeVisible();
    await expect(address).toHaveValue('/site/index.html');
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(frame(page).getByRole('heading', { name: '第二页' })).toBeVisible();
    await expect(address).toHaveValue('/site/other.html');
    // 地址栏直接输入工作区里的路径，回车加载；这也算一次访问，可以再后退
    await address.fill('/site/index.html');
    await address.press('Enter');
    await expect(heading).toBeVisible();
    await expect(address).toHaveValue('/site/index.html');
    await expect(back).toBeEnabled();
    // 深色主题下的工具栏（等配色过渡走完再截图）
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screens, '50c-site-browser-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    // 外网地址不能在这里打开：提示原因，Esc 放弃修改后地址栏回到当前页面
    await address.fill('https://example.com');
    await address.press('Enter');
    await expect(page.getByText('只能打开本机服务')).toBeVisible();
    await expect(heading).toBeVisible();
    await address.press('Escape');
    await expect(address).toHaveValue('/site/index.html');
    await page.screenshot({ path: join(screens, '50-site-preview-panel-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.screenshot({ path: join(screens, '50-site-preview-panel-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    // 出域请求一律 404：页面里 fetch 工作区外的文件拿不到
    const status = await frame(page).locator('body').evaluate(async () => (await fetch('../../../etc/hosts')).status);
    expect(status).toBe(404);
    // 侧栏挤压对话：对话输入框仍在旁边可用；「展开全部」盖住对话区（左侧会话栏还在），再收回
    const side = page.getByTestId('chat-side-panel');
    await expect(side).toHaveAttribute('data-expanded', 'false');
    await expect(page.getByLabel('消息')).toBeInViewport();
    await side.getByRole('button', { name: '展开全部' }).click();
    await expect(side).toHaveAttribute('data-expanded', 'true');
    const chatBox = await page.locator('main').boundingBox();
    const sideBox = await side.boundingBox();
    expect(sideBox?.width).toBe(chatBox?.width);
    await expect(page.getByRole('button', { name: '新建对话' })).toBeInViewport();
    await page.screenshot({ path: join(screens, '50-site-preview-panel-expanded.png') });
    // 左侧会话栏收起时，展开的侧栏顶栏（标签栏）给侧栏开关让位：第一个标签不被开关盖住
    await page.getByRole('button', { name: '收起侧栏' }).click();
    // 开关收起时有 200ms 的位移动画：等它停稳再比位置
    await expect
      .poll(async () => {
        const toggleBox = await page.getByRole('button', { name: '展开侧栏' }).boundingBox();
        const titleBox = await side.getByRole('tab').first().boundingBox();
        return titleBox && toggleBox ? Math.round(titleBox.x - (toggleBox.x + toggleBox.width)) : null;
      })
      .toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: join(screens, '50-site-preview-panel-expanded-collapsed.png') });
    await page.getByRole('button', { name: '展开侧栏' }).click();
    // Esc：展开时收回，停靠时关闭
    await page.keyboard.press('Escape');
    await expect(side).toHaveAttribute('data-expanded', 'false');
    // 拖左边缘调宽：往右拖 120px 窄 120px（往左已到「给对话留 360px」的上限）；重新打开仍是这个宽度（记在本机）
    const before = (await side.boundingBox())?.width ?? 0;
    const handle = side.getByRole('separator', { name: '拖动调整侧栏宽度' });
    const hb = await handle.boundingBox();
    if (!hb) throw new Error('找不到拖宽把手');
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2, { steps: 5 });
    await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Math.round(before - ((await side.boundingBox())?.width ?? 0))).toBeCloseTo(120, -1);
    const resized = (await side.boundingBox())?.width ?? 0;
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();
    await page.getByRole('button', { name: '工作区文件', exact: true }).click();
    if (!(await sheet.getByRole('button', { name: 'index.html' }).isVisible())) {
      await sheet.getByRole('button', { name: 'site' }).click();
    }
    await sheet.getByRole('button', { name: 'index.html' }).click();
    await sheet.getByRole('button', { name: '预览网页' }).click();
    await expect.poll(async () => Math.round((await side.boundingBox())?.width ?? 0)).toBe(Math.round(resized));
    await closeSidePanel(page);
  } finally {
    await app.close();
  }
});

test('网页预览（真实模型）：preview_page 静态页 / 端口、对话链接、后台服务', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

  mkdirSync(dirs.workspace, { recursive: true });
  const server = await startServer();
  const port = (server.address() as AddressInfo).port;
  const bgPort = await freePort();

  const { app, page } = await launch(dirs);
  await app.evaluate(({ ipcMain }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { __opened: opened });
    ipcMain.removeHandler('desktop:openExternal');
    ipcMain.handle('desktop:openExternal', (_e, url: string) => {
      opened.push(url);
    });
  });
  try {
    await saveGoogleKey(page);
    await newChat(page);
    await setPermission(page, '自动');

    // 1) 静态页：写完调 preview_page → 自动弹出
    await sendAndWait(
      page,
      '在工作区写一个静态页 hello/index.html：标题 h1 文字是「静态页预览」，下面一个按钮文字是「加一」，' +
        '按钮旁边一个 id 为 count 的 span 初始为 0，点按钮加一（内联 script）。h1 的颜色写在 hello/style.css 里（color: rgb(200, 30, 30)），' +
        '页面用相对路径 style.css 引用它。写完调用 preview_page 预览这个页面。',
    );
    await expect(viewer(page)).toBeVisible();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toHaveCSS('color', 'rgb(200, 30, 30)');
    await frame(page).getByRole('button', { name: '加一' }).click();
    await expect(frame(page).locator('#count')).toHaveText('1');
    await page.screenshot({ path: join(screens, '51-site-preview-file.png') });
    // 刷新：iframe 重新加载，计数回到 0
    await viewer(page).getByRole('button', { name: '刷新' }).click();
    await expect(frame(page).locator('#count')).toHaveText('0');
    await closeSidePanel(page);

    // 消息流里留下卡片，可再次打开
    const timeline = page.getByTestId('timeline');
    await timeline.getByRole('button', { name: '预览', exact: true }).first().click();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await closeSidePanel(page);

    // 顶栏的侧栏开关：收起着就重新打开，标签还在（回到刚才的网页）
    await page.getByTestId('side-panel-toggle').click();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    // 加号 → 新建标签页：产出物里列着这个网页；点它——已经开着，切回那个标签，新建标签页收掉
    const side = page.getByTestId('chat-side-panel');
    await side.getByRole('button', { name: '新建标签页' }).click();
    await expect(side.getByRole('tab')).toHaveCount(2);
    const launcher = page.getByTestId('side-panel-launcher');
    const sites = launcher.getByRole('list', { name: '网页预览' });
    await expect(sites.getByRole('button')).toHaveCount(1);
    await expect(sites).toContainText('hello/index.html');
    await page.screenshot({ path: join(screens, '51b-side-panel-launcher-outputs.png') });
    await sites.getByRole('button').click();
    await expect(launcher).toBeHidden();
    await expect(side.getByRole('tab')).toHaveCount(1);
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await closeSidePanel(page);

    // 2) 工作区面板：选中 .html → 预览网页（面板收起，网页开在侧栏）
    await page.getByRole('button', { name: '工作区文件', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'hello' }).click();
    await sheet.getByRole('button', { name: 'index.html' }).click();
    await sheet.getByRole('button', { name: '预览网页' }).click();
    await expect(sheet).toBeHidden();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await closeSidePanel(page);

    // 3) 端口：已在运行的本机服务 + 应用内 path
    await sendAndWait(
      page,
      `本机 ${port} 端口上已经有一个 web 服务在运行。不要启动任何服务、不要执行命令，直接调用 preview_page 预览它的 /about 页面。`,
    );
    await expect(frame(page).getByRole('heading', { name: '关于页' })).toBeVisible();
    await expect(viewer(page).getByRole('textbox', { name: '地址' })).toHaveValue(`localhost:${port}/about`);
    await closeSidePanel(page);

    // 4) 对话链接：本机服务 / 工作区 .html 都在应用内预览
    await sendAndWait(
      page,
      [
        '请原样输出下面这段 Markdown，不要改动、不要放进代码块、不要加任何别的文字，也不要调用工具：',
        '',
        `[本机服务](http://localhost:${port}/)`,
        '',
        '[静态页链接](hello/index.html)',
      ].join('\n'),
    );
    await timeline.getByRole('link', { name: '本机服务' }).click();
    await expect(frame(page).getByRole('heading', { name: '本机服务首页' })).toBeVisible();
    await page.screenshot({ path: join(screens, '52-site-preview-port-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.screenshot({ path: join(screens, '53-site-preview-port-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await closeSidePanel(page);
    await timeline.getByRole('link', { name: '静态页链接' }).click();
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await closeSidePanel(page);
    expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual([]);

    // 5) 后台拉起服务 → 紧接着预览（工具等端口就绪）
    await sendAndWait(
      page,
      `用 run_in_background 在工作区的 hello 目录运行 \`python3 -m http.server ${bgPort} --bind 127.0.0.1\`，` +
        `然后立刻调用 preview_page 预览端口 ${bgPort} 的 /index.html，不要等后台任务结束。`,
    );
    await expect(frame(page).getByRole('heading', { name: '静态页预览' })).toBeVisible();
    await page.screenshot({ path: join(screens, '54-site-preview-background.png') });
    await closeSidePanel(page);
  } finally {
    await app.close();
    server.close();
    // 兜底：后台 http.server 若还活着就杀掉
    try {
      const pids = execFileSync('lsof', ['-ti', `tcp:${bgPort}`], { encoding: 'utf8' }).trim();
      if (pids) execFileSync('kill', pids.split('\n'));
    } catch {
      // 没有进程在监听
    }
  }
});
