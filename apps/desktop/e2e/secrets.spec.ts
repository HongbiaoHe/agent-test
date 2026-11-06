/**
 * 密钥解不开（钥匙串被重置 / secrets.json 从别处拷来）时应用照常可用（不需要模型）：
 * 以前 main 解密直接抛错，agent-host 起不来，「新建对话」永远在等。
 * 现在解不开的 Key 按未配置处理：首页提示先填写 Key，设置里显示未配置，新建对话正常。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, newChat, openSettings, tempDirs } from './helpers';

const dirs = tempDirs('secrets');

test('解不开的密钥按未配置处理，应用照常启动、能新建对话', async () => {
  mkdirSync(dirs.workspace, { recursive: true });
  mkdirSync(dirs.userData, { recursive: true });
  const foreign = Buffer.from('ciphertext from another keychain').toString('base64');
  writeFileSync(
    join(dirs.userData, 'secrets.json'),
    JSON.stringify({ google: foreign, deepseek: foreign, mcpKey: foreign, webToken: foreign, webEmail: 'a@b.test' }),
  );
  const { app, page } = await launch(dirs);
  try {
    await expect(page.getByRole('button', { name: '先填写模型 Key' })).toBeVisible({ timeout: 20_000 });
    await newChat(page);
    await openSettings(page, '模型');
    await expect(page.getByText('已配置')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
