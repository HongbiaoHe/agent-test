/**
 * Spark 桌面端端到端（真实模型，会产生少量费用）：
 *   SPARK_E2E_GOOGLE_API_KEY=... pnpm --filter desktop e2e
 * 用临时 userData / 工作区，不碰本机已有数据。截图写到 test-results/screens/。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { apiKey, closeSettings, launch, newChat, openSettings, screens, tempDirs, waitTurn } from './helpers';

const { userData, workspace } = tempDirs('basic');

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('填 Key → 对话 → 写文件与命令逐个审批 → token 报表与文件面板 → 结果落库；重启后会话还在', async () => {
  let { app, page } = await launch({ userData, workspace }, { skipLogin: false });

  // 首次启动：登录页（邮箱 + 验证码），可以先跳过
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: join(screens, '0-login.png') });
  await page.getByRole('button', { name: '先跳过，不登录使用' }).click();
  // 没登录：侧栏用户区显示「未登录 · 登录」
  await expect(page.getByTestId('sidebar-user')).toHaveText('未登录 · 登录');

  // 没有 Key：引导去设置弹窗的「模型」分类
  await expect(page.getByRole('heading', { name: 'Spark' })).toBeVisible();
  await page.getByRole('button', { name: '先填写模型 Key' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await page.getByLabel('Google Gemini API Key').fill(apiKey);
  await page.getByRole('button', { name: '保存' }).first().click();
  await expect(page.getByText('已配置').first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: join(screens, '1-settings.png') });
  await openSettings(page, '工作区');
  await expect(page.getByTestId('workspace-dir')).toHaveText(workspace);
  await openSettings(page, '账号');
  await expect(page.getByRole('dialog')).toContainText('未登录');
  await page.screenshot({ path: join(screens, '1b-settings-account.png') });

  // 外观：选深色 → main 设 nativeTheme.themeSource，页面跟着挂 .dark（先撤掉 Playwright 默认的浅色模拟）
  await openSettings(page, '外观');
  await page.emulateMedia({ colorScheme: null });
  await page.getByRole('radio', { name: /深色/ }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
  await page.screenshot({ path: join(screens, '1c-settings-theme-dark.png') });
  await page.getByRole('radio', { name: /浅色/ }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('radio', { name: /跟随系统/ }).click();
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await closeSettings(page);

  // 新对话（默认「询问」权限）→ 让 agent 写文件并执行命令：写文件与命令都要逐个批准
  await newChat(page);
  await expect(page.getByRole('button', { name: '权限：询问' })).toBeVisible();
  await expect(page.getByRole('button', { name: '工作区文件夹' })).toContainText('workspace');
  const input = page.getByLabel('消息');
  await input.fill(
    '请用 write_file 在工作区根目录创建 e2e.txt，内容是 desktop-e2e-ok；然后用 execute 运行 `cat e2e.txt`，把输出原样告诉我。不要做别的。',
  );
  await input.press('Enter');

  const approval = page.getByTestId('approval-panel');
  await expect(approval).toBeVisible({ timeout: 150_000 });
  await expect(approval).toContainText('write_file');
  await page.screenshot({ path: join(screens, '2-approval.png') });
  const approved = await waitTurn(page);
  expect(approved).toBeGreaterThanOrEqual(1);
  expect(readFileSync(join(workspace, 'e2e.txt'), 'utf8')).toContain('desktop-e2e-ok');
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('desktop-e2e-ok');
  await page.screenshot({ path: join(screens, '3-done.png') });

  // token 统计：顶栏徽标 → 报表弹窗（按模型 / 每轮）
  const badge = page.getByRole('button', { name: /tokens$/ });
  await expect(badge).not.toHaveText('0 tokens');
  await badge.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('gemini-3.8-flash');
  await expect(dialog).toContainText('e2e.txt');
  await page.screenshot({ path: join(screens, '3b-token-usage.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // 右上角工作区文件：文件树里有 e2e.txt，点开预览内容
  await page.getByRole('button', { name: '工作区文件', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(workspace);
  await sheet.getByRole('button', { name: 'e2e.txt' }).click();
  await expect(sheet).toContainText('desktop-e2e-ok');
  await page.screenshot({ path: join(screens, '3c-workspace-files.png') });
  await page.keyboard.press('Escape');

  // 数据确实落在本机 SQLite
  const db = new DatabaseSync(join(userData, 'spark.db'), { readOnly: true });
  const conv = db.prepare('SELECT id, status FROM conversation').get();
  expect(conv?.status).toBe('done');
  const types = db
    .prepare('SELECT type FROM message WHERE conversation_id = ? ORDER BY seq')
    .all(String(conv?.id))
    .map((r) => String(r.type));
  expect(types).toEqual(expect.arrayContaining(['message', 'tool_start', 'tool_end', 'control_request', 'result']));
  const approvals = db.prepare('SELECT decision FROM approval').all();
  expect(approvals.every((r) => r.decision === 'approve')).toBe(true);
  expect(approvals.length).toBe(approved);
  db.close();

  // 重启应用：会话和历史还在，Key 仍然有效
  await app.close();
  // 跳过登录会被记住：重启后直接进主界面，不再出现登录页
  ({ app, page } = await launch({ userData, workspace }, { skipLogin: false }));
  await expect(page.getByRole('button', { name: '新建对话' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '会话' })).toContainText('e2e.txt', { timeout: 20_000 });
  // 侧栏按日期分组，组标题也是按钮：按会话标题点
  await page.getByRole('navigation', { name: '会话' }).getByRole('button').filter({ hasText: 'e2e.txt' }).first().click();
  await expect(page.getByTestId('timeline')).toContainText('desktop-e2e-ok');
  // 已开始的会话不能再换目录
  await expect(page.getByRole('button', { name: '工作区文件夹' })).toBeDisabled();
  await page.screenshot({ path: join(screens, '4-after-restart.png') });

  // 暗色：界面跟随 prefers-color-scheme，<html> 挂上 .dark。
  // Playwright 默认把页面配色模拟成 light（会盖过 nativeTheme），所以用 emulateMedia 切换
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  // 输入框带 transition-colors：等它的背景过渡到暗色 --card 再截图（否则会截到过渡中间的浅灰）
  const composer = page.getByLabel('消息').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
  await expect
    .poll(() =>
      composer.evaluate((el) => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--card)';
        document.body.append(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return getComputedStyle(el).backgroundColor === want;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: join(screens, '4b-dark.png') });
  expect(existsSync(join(userData, 'secrets.json'))).toBe(true);
  expect(readFileSync(join(userData, 'secrets.json'), 'utf8')).not.toContain(apiKey);
  await app.close();
});
