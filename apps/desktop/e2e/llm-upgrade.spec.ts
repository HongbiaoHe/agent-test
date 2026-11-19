/**
 * 升级迁移：旧版只有设备级的 Gemini / DeepSeek Key（secrets.json，系统钥匙串加密）+ 写死的 `provider:model`。
 * 新版第一次打开某个账号时：旧 Key 复制进账号自己的 model-keys.json、建好两个连接并启用原来的模型、
 * 旧模型名改写成「连接 id/模型 id」、旧默认模型变成账号默认模型；本机已知账号都迁完后删掉设备级旧 Key。
 *
 * 做法：先启动一次拿到真实的 safeStorage，在 main 里把旧版的密文写进 secrets.json、旧默认模型写进
 * settings.json；关掉后删掉这次启动生成的账号数据（模拟旧版从没有过它们），用旧格式的模型名建一个会话；
 * 再启动新版验证迁移结果，并在那个旧会话里用迁移过来的 Key 真实对话。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ConversationRepo } from '../src/agent-host/db/conversations';
import { openDatabase } from '../src/agent-host/db/database';
import { apiKey, closeSettings, launch, openSettings, screens, sendAndWait, tempDirs } from './helpers';

test('旧版设备级 Key 升级：迁成账号的两个连接、旧模型名与默认模型改写、设备级旧 Key 删掉、旧会话照常对话', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');
  test.setTimeout(240_000);
  const dirs = tempDirs('llm-upgrade');

  // 1) 拿真实 safeStorage 写旧版的设备级密文与旧默认模型
  {
    const { app } = await launch(dirs);
    await app.evaluate(
      ({ safeStorage }, { userData, google }) => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const enc = (s: string) => safeStorage.encryptString(s).toString('base64');
        const secretsFile = path.join(userData, 'secrets.json');
        const secrets: Record<string, unknown> = fs.existsSync(secretsFile)
          ? (JSON.parse(fs.readFileSync(secretsFile, 'utf8')) as Record<string, unknown>)
          : {};
        fs.writeFileSync(secretsFile, JSON.stringify({ ...secrets, google: enc(google), deepseek: enc('sk-legacy') }));
        const settingsFile = path.join(userData, 'settings.json');
        const settings: Record<string, unknown> = fs.existsSync(settingsFile)
          ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
          : {};
        fs.writeFileSync(
          settingsFile,
          JSON.stringify({ ...settings, defaultModel: 'google-genai:gemini-3.8-flash', loginSkipped: true }),
        );
      },
      { userData: dirs.userData, google: apiKey },
    );
    await app.close();
  }

  // 2) 模拟旧版：账号里还没有新格式的任何东西；旧会话存的是旧模型名
  rmSync(join(dirs.userData, 'model-keys.json'), { force: true });
  for (const f of ['spark.db', 'spark.db-wal', 'spark.db-shm']) rmSync(join(dirs.userData, f), { force: true });
  {
    const db = openDatabase(join(dirs.userData, 'spark.db'));
    const repo = new ConversationRepo(db, () => dirs.workspace);
    const c = repo.create('google-genai:gemini-3.8-flash', { dir: dirs.workspace });
    repo.update(c.id, { title: '升级前的旧对话', goal: '升级前的旧对话' });
    // 旧版没有 v12 的表：只删掉迁移标记即可（表是空的，等同旧版）
    db.prepare("DELETE FROM profile_setting WHERE key = 'legacy_models_migrated'").run();
    db.close();
  }

  // 3) 新版启动：自动迁移
  const { app, page } = await launch(dirs);
  try {
    await openSettings(page, '模型');
    const settings = page.getByRole('dialog');
    await expect(settings.getByText('Google Gemini', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(settings.getByText('DeepSeek', { exact: true }).first()).toBeVisible();
    await expect(settings.getByRole('combobox', { name: '默认模型' })).toContainText('gemini-3.8-flash');
    await page.screenshot({ path: join(screens, 'llm-upgrade-settings.png') });
    await closeSettings(page);

    // Key 进了账号自己的文件；本机只有访客这一个账号 → 设备级旧 Key 已删
    const profileKeys: unknown = JSON.parse(readFileSync(join(dirs.userData, 'model-keys.json'), 'utf8'));
    expect(profileKeys).toMatchObject({ legacyConnections: [{ presetId: 'gemini' }, { presetId: 'deepseek' }] });
    const secrets: unknown = JSON.parse(readFileSync(join(dirs.userData, 'secrets.json'), 'utf8'));
    expect(secrets).not.toHaveProperty('google');
    expect(secrets).not.toHaveProperty('deepseek');
    expect(existsSync(join(dirs.userData, 'model-keys.json'))).toBe(true);

    // 旧会话：模型名已改写成新引用（下拉显示模型 id），用迁移过来的 Key 真实对话
    await page.getByText('升级前的旧对话').first().click();
    await expect(page.getByRole('button', { name: 'gemini-3.8-flash' }).or(page.getByRole('button', { name: '模型：gemini-3.8-flash' }))).toBeVisible();
    await sendAndWait(page, '只回复两个字：收到');
    await expect(page.getByTestId('timeline')).toContainText('收到', { timeout: 60_000 });
    await page.screenshot({ path: join(screens, 'llm-upgrade-chat.png') });
  } finally {
    await app.close();
  }
});
