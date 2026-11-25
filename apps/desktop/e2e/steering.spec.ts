/**
 * 运行中插入 / 排队消息（真实模型）：
 *   SPARK_E2E_GOOGLE_API_KEY=... pnpm --filter desktop e2e e2e/steering.spec.ts
 * - 插入：agent 跑慢命令时按 Enter 发一条补充 → 进待发列表（下一步插入）→ 工具跑完后送达、变成对话里的用户气泡，
 *   agent 在同一轮里照做；落库顺序是「工具结果 → 插入的消息 → 后续回复」。
 * - 排队：按 ⌘Enter → 待发列表（本轮结束后）→ 这一轮结束后自动开新一轮处理它。
 * - 停止：没送达的消息留在待发列表，不自动开跑；可以删除、编辑（退回输入框）。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { apiKey, launch, newChat, saveGoogleKey, screens, setPermission, tempDirs, waitTurn } from './helpers';

const dirs = tempDirs('steering');

/** 只读查 e2e 用的那份库（访客空间：userData/spark.db） */
function query(sql: string): string[] {
  return execFileSync('sqlite3', ['-readonly', join(dirs.userData, 'spark.db'), sql], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('运行中 Enter 插入、⌘Enter 排队；停止后待发消息留着，可删可改', async () => {
  const { app, page } = await launch(dirs);
  await saveGoogleKey(page);
  await newChat(page);
  await setPermission(page, '自动');
  const input = page.getByLabel('消息');
  const timeline = page.getByTestId('timeline');
  const stop = page.getByRole('button', { name: '停止' });
  const send = page.getByRole('button', { name: '发送', exact: true });
  const pending = page.getByTestId('pending-list');
  const occurrences = async (needle: string) => (await timeline.innerText()).split(needle).length - 1;

  // ── 插入 ──
  await input.fill('用 execute 运行 `sleep 8 && echo STEP-ONE-DONE`，等它跑完后把输出告诉我。不要做别的。');
  await input.press('Enter');
  await expect(stop).toBeVisible({ timeout: 20_000 });
  // 等命令真的跑起来再发：这样消息是在「工具执行期间」发出的，要等工具跑完才插入
  // （发得更早也没问题——那就是在第一次模型调用前插入，但测不到「排在工具结果之后」）
  await expect(page.getByRole('button', { name: /^bash sleep 8/ })).toBeVisible({ timeout: 60_000 });
  // 运行中：输入框空着只有停止；输入内容后发送与停止并排，占位文字提示两种发法；附件按钮可用
  await expect(send).toBeHidden();
  await expect(input).toHaveAttribute('placeholder', /Enter 插入 · ⌘Enter 排队/);
  await expect(page.getByRole('button', { name: '添加附件' })).toBeEnabled();
  await input.fill('另外，请在最终回答的末尾加上暗号 ZEBRA-7。');
  await expect(send).toBeVisible();
  await expect(stop).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(pending.getByTestId('pending-item')).toHaveCount(1);
  await expect(pending).toContainText('下一步插入');
  await expect(pending).toContainText('ZEBRA-7');
  await page.screenshot({ path: join(screens, '95-steer-pending.png') });
  // 工具跑完、下一次模型调用前送达：待发列表清空，对话里多出这条用户气泡
  await expect(pending).toBeHidden({ timeout: 90_000 });
  await waitTurn(page);
  // 用户气泡一次 + agent 的回答里照做了一次
  expect(await occurrences('ZEBRA-7')).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: join(screens, '96-steer-delivered.png') });

  // 落库顺序：插入的消息排在工具结果之后、最后的回答之前；只跑了一轮（一个 result）
  const rows = query(
    "SELECT role || ':' || type || ':' || COALESCE(json_extract(content, '$.injected'), 0) FROM message ORDER BY seq",
  ).filter((r) => !r.includes(':reasoning:'));
  const injectedAt = rows.indexOf('user:message:1');
  expect(injectedAt).toBeGreaterThan(rows.indexOf('tool:tool_end:0'));
  expect(injectedAt).toBeLessThan(rows.lastIndexOf('assistant:message:0'));
  expect(rows.filter((r) => r.startsWith('assistant:result'))).toHaveLength(1);
  // 缓存命中情况（只打印，不断言：隐式缓存由服务商决定）
  console.log('token_usage（input / cache_read，按调用顺序）:', query('SELECT input_tokens || "/" || cache_read_tokens FROM token_usage ORDER BY created_at, rowid').join('  '));

  // ── 排队 ──
  await input.fill('用 execute 运行 `sleep 6 && echo STEP-TWO-DONE`，跑完后只回复 OK-TWO，不要说别的。');
  await input.press('Enter');
  await expect(stop).toBeVisible({ timeout: 20_000 });
  await input.fill('只回复这几个字：QUEUED-DONE-42');
  await input.press('Meta+Enter');
  await expect(pending).toContainText('本轮结束后');
  await page.screenshot({ path: join(screens, '97-queue-pending.png') });
  // 这一轮结束后自动开新一轮：气泡一次 + 回复一次
  await expect.poll(() => occurrences('QUEUED-DONE-42'), { timeout: 150_000 }).toBeGreaterThanOrEqual(2);
  await waitTurn(page);
  await expect(pending).toBeHidden();
  const text = await timeline.innerText();
  // 排队的消息是在上一轮的回复之后才出现的
  expect(text.indexOf('QUEUED-DONE-42')).toBeGreaterThan(text.indexOf('OK-TWO'));
  // 排队的消息是新一轮的普通用户消息：库里现在有 3 个 result（三轮）
  expect(query("SELECT COUNT(*) FROM message WHERE type = 'result'")).toEqual(['3']);

  // ── 停止后留着 ──
  await input.fill('用 execute 运行 `sleep 60 && echo NEVER`，跑完告诉我。');
  await input.press('Enter');
  await expect(stop).toBeVisible({ timeout: 20_000 });
  await input.fill('留着的排队消息');
  await input.press('Meta+Enter');
  await input.fill('留着的插入消息');
  await input.press('Enter');
  await expect(pending.getByTestId('pending-item')).toHaveCount(2);
  await stop.click();
  await expect(send).toBeVisible({ timeout: 30_000 });
  // 不自动开跑：待发消息还在，顶上给「发送」
  await page.waitForTimeout(2000);
  await expect(stop).toBeHidden();
  await expect(pending).toContainText('2 条消息还没发送');
  await expect(pending.getByTestId('pending-send')).toBeVisible();
  await page.screenshot({ path: join(screens, '98-pending-after-stop.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screens, '99-pending-after-stop-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  // 删一条
  await pending.getByTestId('pending-item').filter({ hasText: '留着的排队消息' }).getByRole('button', { name: '删除' }).click();
  await expect(pending.getByTestId('pending-item')).toHaveCount(1);
  // 编辑另一条：退回输入框，待发列表清空
  await pending.getByTestId('pending-item').getByRole('button', { name: '编辑' }).click();
  await expect(input).toHaveValue('留着的插入消息');
  await expect(pending).toBeHidden();
  expect(query('SELECT COUNT(*) FROM pending_message')).toEqual(['0']);
  await app.close();
});
