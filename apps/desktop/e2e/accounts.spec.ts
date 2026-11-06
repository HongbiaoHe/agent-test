/**
 * 按账号隔离（真实 Web 后端 + 真实模型）：
 *   SPARK_E2E_WEB_API=http://127.0.0.1:3101 SPARK_E2E_REDIS_CONTAINER=agent-test-redis-1 SPARK_E2E_GOOGLE_API_KEY=... \
 *   pnpm --filter desktop e2e e2e/accounts.spec.ts
 * 访客建会话 → 登录后看不到访客会话，建自己的会话、装技能 → 退出回访客空间只看到访客数据 → 再登录看到自己的。
 * 模型 Key 是设备级：换账号不用重填。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  apiKey,
  closeSettings,
  launch,
  newChat,
  openSettings,
  saveGoogleKey,
  screens,
  sendAndWait,
  stubOpenDialog,
  tempDirs,
} from './helpers';

const webApi = process.env.SPARK_E2E_WEB_API ?? '';
const EMAIL = 'e2e-spark-isolation@example.test';
const dirs = tempDirs('accounts');

test.skip(!apiKey || !webApi, '需要 SPARK_E2E_GOOGLE_API_KEY、SPARK_E2E_WEB_API');

async function signIn(page: Page) {
  const redis = process.env.SPARK_E2E_REDIS_CONTAINER;
  if (redis) execFileSync('docker', ['exec', redis, 'redis-cli', 'DEL', `auth:code:limit:${EMAIL}`]);
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('邮箱地址').fill(EMAIL);
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByLabel('验证码')).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page.getByTestId('sidebar-user')).toHaveText(EMAIL, { timeout: 30_000 });
}

async function signOut(page: Page) {
  await openSettings(page, '账号');
  await page.getByRole('button', { name: '退出登录' }).click();
  // 退出后回到登录页（不沿用之前的「跳过」），再跳过进访客空间
  await page.getByRole('button', { name: '先跳过，不登录使用' }).click({ timeout: 20_000 });
  await expect(page.getByTestId('sidebar-user')).toHaveText('未登录 · 登录');
}

const conversations = (page: Page) => page.getByRole('navigation', { name: '会话' });

test('会话与技能按账号隔离，访客数据留在访客空间', async () => {
  const skillDir = join(dirs.root, 'user-only-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: user-only-skill\ndescription: 只属于登录用户的技能\n---\nbody');

  const { app, page } = await launch(dirs, { env: { SPARK_WEB_API_URL: webApi } });
  await saveGoogleKey(page);

  // 访客：建一个会话
  await newChat(page);
  await sendAndWait(page, '只回复：guest-ok');
  await expect(conversations(page)).toContainText('guest-ok');

  // 登录：访客会话不可见；建自己的会话、装一个技能
  await page.getByTestId('sidebar-user').click();
  await signIn(page);
  await expect(conversations(page)).not.toContainText('guest-ok');
  await newChat(page); // 模型 Key 是设备级：不用重填就能发消息
  await sendAndWait(page, '只回复：user-ok');
  await expect(conversations(page)).toContainText('user-ok');
  await openSettings(page, '技能');
  await stubOpenDialog(app, [skillDir]);
  await page.getByRole('button', { name: '从文件夹导入' }).click();
  await expect(page.getByText('user-only-skill', { exact: true })).toBeVisible();
  await closeSettings(page);
  await page.screenshot({ path: join(screens, '19-account-space.png') });

  // 退出：回到访客空间，只看到访客数据
  await signOut(page);
  // 设置弹窗不会在回到主界面后又盖上来（退出登录是在设置里点的）
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeHidden();
  await expect(conversations(page)).toContainText('guest-ok');
  await expect(conversations(page)).not.toContainText('user-ok');
  await openSettings(page, '技能');
  await expect(page.getByText('create-skills', { exact: true })).toBeVisible();
  await expect(page.getByText('user-only-skill', { exact: true })).toHaveCount(0);
  await closeSettings(page);
  await page.screenshot({ path: join(screens, '20-guest-space.png') });

  // 再登录：自己的会话和技能都还在
  await page.getByTestId('sidebar-user').click();
  await signIn(page);
  await expect(conversations(page)).toContainText('user-ok');
  await expect(conversations(page)).not.toContainText('guest-ok');
  await openSettings(page, '技能');
  await expect(page.getByText('user-only-skill', { exact: true })).toBeVisible();
  await closeSettings(page);
  await app.close();
});
