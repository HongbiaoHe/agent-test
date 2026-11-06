/**
 * aigc 端到端（真实 Web 后端 + aigc，会消耗少量生成额度）：
 *   SPARK_E2E_WEB_API=http://127.0.0.1:3201 SPARK_E2E_GOOGLE_API_KEY=... pnpm --filter desktop e2e e2e/aigc.spec.ts
 * 登录页用 Web 测试账号登录（测试环境后端直接返回验证码）→ 对话里带参考图生图 → 媒体卡片出图 →
 * sync_media_to_sandbox 把图下载进本机工作区。
 * SPARK_E2E_REDIS_CONTAINER：后端用的 Redis 容器名；给了就先清掉测试账号的验证码限流（60 秒一次）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
  apiKey,
  closeSettings,
  launch,
  newChat,
  openSettings,
  saveGoogleKey,
  screens,
  sendAndWait,
  setPermission,
  stubOpenDialog,
  tempDirs,
} from './helpers';

const webApi = process.env.SPARK_E2E_WEB_API ?? '';
const refImage = process.env.SPARK_E2E_REF_IMAGE ?? '';
const EMAIL = 'e2e-spark-desktop@example.test';
const dirs = tempDirs('aigc');

test.skip(!apiKey || !webApi || !refImage, '需要 SPARK_E2E_GOOGLE_API_KEY、SPARK_E2E_WEB_API、SPARK_E2E_REF_IMAGE');

test('登录 Web 账号 → 带参考图生图 → 卡片出图 → 同步进工作区', async () => {
  const redis = process.env.SPARK_E2E_REDIS_CONTAINER;
  if (redis) execFileSync('docker', ['exec', redis, 'redis-cli', 'DEL', `auth:code:limit:${EMAIL}`]);

  // 登录页：只填邮箱 + 验证码（测试环境后端直接返回验证码并自动填入）；后端地址经 env 指到测试后端
  const { app, page } = await launch(dirs, { skipLogin: false, env: { SPARK_WEB_API_URL: webApi } });
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('邮箱地址').fill(EMAIL);
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByLabel('验证码')).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.screenshot({ path: join(screens, '16-login-code.png') });
  await page.getByRole('button', { name: '验证并登录' }).click();
  // 登录后进主界面，侧栏用户区显示账号
  await expect(page.getByTestId('sidebar-user')).toHaveText(EMAIL, { timeout: 30_000 });
  await saveGoogleKey(page);
  await openSettings(page, '账号');
  await expect(page.getByTestId('web-account-email')).toHaveText(EMAIL);
  await page.screenshot({ path: join(screens, '16b-account.png') });
  await closeSettings(page);

  // 对话：自动档位（sync 下载进工作区不用审批），带参考图生图
  await newChat(page);
  await setPermission(page, '自动');
  await stubOpenDialog(app, [refImage]);
  await page.getByRole('button', { name: '添加附件' }).click();
  await sendAndWait(
    page,
    '我确认要生成：用 generate_image 生成 1 张图，提示词「a red apple on a white table, studio light」，用默认模型，把我附件里的图作为参考图（referenceVersionIds 用附件的 versionId）。不用再问我，直接调用。',
  );
  const timeline = page.getByTestId('timeline');
  const generated = timeline.locator('img[alt="Generated image"]');
  // 失败时留现场：截图 + 当前视图（排查过一次「对话区被换成设置页」的偶发问题）
  await expect(generated)
    .toBeVisible({ timeout: 150_000 })
    .catch(async (e: unknown) => {
      await page.screenshot({ path: join(screens, `aigc-fail-${Date.now()}.png`) });
      throw e;
    });
  await expect.poll(() => generated.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0))).toBeGreaterThan(0);
  await page.screenshot({ path: join(screens, '17-aigc-image.png') });

  // 附件确实上传成了生成素材（消息里记下了 versionId）
  // 登录后的数据在该账号自己的目录（user-data/users/<Web 用户 id>/），访客库里没有
  const [userDir] = readdirSync(join(dirs.userData, 'users'));
  const db = new DatabaseSync(join(dirs.userData, 'users', userDir, 'spark.db'), { readOnly: true });
  const first = db.prepare("SELECT content FROM message WHERE role = 'user' ORDER BY created_at LIMIT 1").get();
  db.close();
  expect(String(first?.content)).toContain('versionId');

  // 同步进工作区：<工作区>/media/<versionId>/<文件名>
  await sendAndWait(page, '用 sync_media_to_sandbox 把刚生成的那张图同步到工作区，然后只回复它在工作区里的路径。');
  const mediaDir = join(dirs.workspace, 'media');
  expect(existsSync(mediaDir)).toBe(true);
  const synced = readdirSync(mediaDir).flatMap((v) => readdirSync(join(mediaDir, v)));
  expect(synced.length).toBeGreaterThan(0);
  await page.screenshot({ path: join(screens, '18-aigc-synced.png') });
  await app.close();
});
