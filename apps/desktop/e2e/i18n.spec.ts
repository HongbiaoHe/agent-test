/**
 * 多语言（不需要模型）：
 * - 设置为「跟随系统」时按系统语言显示（用 SPARK_SYSTEM_LANGUAGE 模拟英文系统）；
 * - 设置 → 外观 → 语言 改成繁体中文，界面立即切换，main 进程的报错也跟着变（agent-host 的见 src/agent-host/i18n.test.ts）；
 * - 重启后保持所选语言。
 */
import { expect, test } from '@playwright/test';
import { launch, screens, tempDirs } from './helpers';

const dirs = tempDirs('i18n');

test('跟随英文系统 → 切到繁体中文 → 重启后保持', async () => {
  let { app, page } = await launch(dirs, { skipLogin: false, env: { SPARK_SYSTEM_LANGUAGE: 'en-US' } });
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Skip for now and use without signing in' }).click();
    await expect(page.getByRole('button', { name: 'Add a model key first' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option', { name: '繁體中文' }).click();

    // 界面即时切换：设置弹窗自己的文案也变了
    await expect(page.getByRole('navigation', { name: '設定分類' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
    await page.screenshot({ path: `${screens}/i18n-zh-hant-settings.png` });

    // main 进程的报错跟着界面语言（经 IPC 进 renderer 的 toast）
    const err = await page.evaluate(async () => {
      try {
        await window.desktop.updateSettings({ workspaceDir: 'relative/path' });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    expect(err).toContain('工作區必須是絕對路徑');
  } finally {
    await app.close();
  }

  // 第一次已跳过登录，这次直接进主界面（helpers 的自动跳过按简体中文找按钮，这里不用）
  ({ app, page } = await launch(dirs, { skipLogin: false, env: { SPARK_SYSTEM_LANGUAGE: 'en-US' } }));
  try {
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
    await expect(page.getByRole('button', { name: '請先填寫模型 Key' })).toBeVisible();
    await page.screenshot({ path: `${screens}/i18n-zh-hant-home.png` });
  } finally {
    await app.close();
  }
});
