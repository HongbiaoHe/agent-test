/**
 * 不需要模型的两条：
 * 1) 窗口全屏：没有红绿灯，收起侧栏后的开关靠左、对话顶栏不再空出红绿灯那一截；退出全屏恢复；
 * 2) 会话详情弹出层：顶栏列表图标打开，显示工作区 / 模型 / 模式 / 权限 / token；「产出物」打开右侧侧栏启动页；
 *    顶栏最右的侧栏开关打开 / 关闭启动页，没有产出物时给提示；
 * 3) 弹层盖在窗口拖动区上时点得动：侧栏开着剪辑器（它的顶栏是拖动区）时，token 详情弹窗的关闭按钮正好压在上面。
 * 有产出物（网页预览）时的列表与点开，在 site-preview.spec 的真实模型用例里测。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, newChat, screens, tempDirs } from './helpers';

const dirs = tempDirs('chat-info');

test('窗口全屏：收起侧栏后开关靠左、顶栏不再给红绿灯让位，退出全屏恢复', async () => {
  const { app, page } = await launch(dirs);
  try {
    await newChat(page);
    await page.getByRole('button', { name: '收起侧栏' }).click();
    const toggle = page.getByRole('button', { name: '展开侧栏' });
    await expect.poll(async () => (await toggle.boundingBox())?.x).toBe(80);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(true));
    await expect(page.locator('html')).toHaveAttribute('data-fullscreen', '', { timeout: 10_000 });
    // left-3 = 12px；对话顶栏的标题紧跟开关（pl-14 = 56px），不再空出红绿灯那一截
    await expect.poll(async () => (await toggle.boundingBox())?.x).toBe(12);
    const title = page.getByRole('button', { name: '会话菜单' });
    await expect
      .poll(async () => {
        const t = await title.boundingBox();
        const b = await toggle.boundingBox();
        return t && b ? Math.round(t.x - (b.x + b.width)) : null;
      })
      .toBeLessThan(24);
    await page.screenshot({ path: join(screens, '64-fullscreen-collapsed.png') });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(false));
    await expect(page.locator('html')).not.toHaveAttribute('data-fullscreen', { timeout: 10_000 });
    await expect.poll(async () => (await toggle.boundingBox())?.x).toBe(80);
    await toggle.click();
  } finally {
    await app.close();
  }
});

test('会话详情弹出层与侧栏启动页：详情显示环境与用量，产出物入口打开启动页，侧栏开关开 / 关', async () => {
  const { app, page } = await launch(dirs);
  try {
    await newChat(page);
    const toggle = page.getByTestId('conversation-info-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    const info = page.getByTestId('conversation-info');
    await expect(info).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(info).toContainText('环境');
    await expect(info).toContainText('workspace');
    await expect(info).toContainText('通用');
    await expect(info).toContainText('询问');
    await expect(info.getByTestId('conversation-info-tokens')).toHaveText('0');
    await expect(info.getByTestId('conversation-info-outputs')).toContainText('0 项');
    // 弹出层不占侧栏：侧栏还没开
    await expect(page.getByTestId('chat-side-panel')).toHaveCount(0);
    await page.screenshot({ path: join(screens, '65-conversation-details.png') });

    // 「产出物」→ 关掉弹出层，右侧侧栏打开启动页（没有产出物时给提示）
    await info.getByTestId('conversation-info-outputs').click();
    await expect(info).toBeHidden();
    const launcher = page.getByTestId('chat-side-panel').getByTestId('side-panel-launcher');
    await expect(launcher).toContainText('这个会话还没有可预览的产出物');
    // 侧栏挤压对话：输入框仍可用
    await expect(page.getByLabel('消息')).toBeInViewport();
    await page.screenshot({ path: join(screens, '65b-side-panel-launcher.png') });

    // 顶栏最右的侧栏开关：开着就关，关着就打开启动页
    const panelToggle = page.getByTestId('side-panel-toggle');
    await expect(panelToggle).toHaveAttribute('aria-pressed', 'true');
    await panelToggle.click();
    await expect(launcher).toBeHidden();
    await expect(panelToggle).toHaveAttribute('aria-pressed', 'false');
    await panelToggle.click();
    await expect(launcher).toBeVisible();
  } finally {
    await app.close();
  }
});

test('弹层盖在窗口拖动区上：token 详情弹窗的关闭按钮不被当成拖窗口，点了能关', async () => {
  // Electron 的拖动区只看元素盒子、不看层叠：弹窗盖在某个 app-drag 顶栏上时，真实鼠标点在那片范围里会被当成
  // 拖窗口吞掉。Playwright 的点击直接发给页面、绕过了这层，所以这里同时断言「关闭按钮底下确实有拖动区」
  // 和「关闭按钮本身是 no-drag」（文档顺序在后的 no-drag 会挖掉底下的拖动区）
  const ws = join(dirs.root, 'drag-workspace');
  mkdirSync(join(ws, 'videos'), { recursive: true });
  writeFileSync(join(ws, 'videos', 'x.sparkvideo.json'), '{ broken');
  const { app, page } = await launch({ userData: join(dirs.root, 'drag-user-data'), workspace: ws });
  try {
    await newChat(page);
    // 侧栏开剪辑器：它的顶栏（拖动区）在标签栏下面，y 48～96
    await page.getByRole('button', { name: '工作区文件', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'videos', exact: true }).click();
    await sheet.getByRole('button', { name: 'x.sparkvideo.json', exact: true }).click();
    await expect(page.getByTestId('chat-side-panel').getByTestId('video-editor')).toBeVisible();

    await page.getByRole('button', { name: /tokens$/ }).click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    // 有很多轮运行时弹窗撑到 max-h（85vh），顶边离窗口顶只有 7.5vh：关闭按钮落进剪辑器顶栏的范围
    await dialog.evaluate(async (el) => {
      if (el instanceof HTMLElement) el.style.height = '85vh';
      // 等打开时的缩放动画走完再量位置（动画中的盒子还没到最终位置）
      await Promise.all(el.getAnimations().map((a) => a.finished));
    });
    const close = dialog.locator('[data-slot="dialog-close"]');
    const probe = await close.evaluate((btn) => {
      const region = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region');
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dragsUnder = [...document.querySelectorAll('.app-drag')].filter((el) => {
        const b = el.getBoundingClientRect();
        return region(el) === 'drag' && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      }).length;
      const overlay = document.querySelector('[data-slot="dialog-overlay"]');
      return {
        dragsUnder,
        close: region(btn),
        popup: btn.parentElement ? region(btn.parentElement) : '',
        overlay: overlay ? region(overlay) : '',
      };
    });
    expect(probe.dragsUnder).toBeGreaterThan(0);
    expect(probe).toMatchObject({ close: 'no-drag', popup: 'no-drag', overlay: 'no-drag' });
    await close.click();
    await expect(dialog).toBeHidden();
    // 没有弹层时顶栏照旧可以拖窗口
    expect(await page.locator('header.app-drag').first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
  } finally {
    await app.close();
  }
});
