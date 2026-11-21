/**
 * 不需要模型的两条：
 * 1) 窗口全屏：没有红绿灯，收起侧栏后的开关靠左、对话顶栏不再空出红绿灯那一截；退出全屏恢复；
 * 2) 会话信息侧栏：对话顶栏最右的按钮开关；显示模型 / 模式 / 权限 / token / 工作区，没有产出物时给提示。
 * 有产出物（网页预览）时的列表与点开，在 site-preview.spec 的真实模型用例里测。
 */
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

test('会话信息侧栏：顶栏按钮开关，显示基本信息与空产出提示', async () => {
  const { app, page } = await launch(dirs);
  try {
    await newChat(page);
    const toggle = page.getByTestId('conversation-info-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    const info = page.getByTestId('chat-side-panel').getByTestId('conversation-info');
    await expect(info).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(info.getByRole('heading', { name: '会话信息' })).toBeVisible();
    await expect(info).toContainText('模式通用');
    await expect(info).toContainText('权限询问');
    await expect(info.getByTestId('conversation-info-tokens')).toHaveText('0');
    await expect(info).toContainText(dirs.workspace);
    await expect(info).toContainText('这个会话还没有可预览的产出物');
    // 侧栏挤压对话：输入框仍可用
    await expect(page.getByLabel('消息')).toBeInViewport();
    await page.screenshot({ path: join(screens, '65-conversation-info.png') });
    // 再点一次关上
    await toggle.click();
    await expect(info).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
  }
});
