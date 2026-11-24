/**
 * 存储管理与删会话清理（真实模型）：
 *   SPARK_E2E_GOOGLE_API_KEY=... pnpm --filter desktop e2e e2e/storage.spec.ts
 * 两个会话各让 agent 新建一个文件（其中一个还改了工作区里原有的文件）→ 设置 → 存储：
 * 按会话 / 按分类看占用 → 清一个会话的缓存（对话还在）→ 勾选删除一个会话（它新建的文件进废纸篓，
 * 改过的原有文件与另一个会话的文件都还在，运行目录没了）→ 侧栏删除另一个会话也同样清干净。
 * 产出文件会真的进本机废纸篓：文件名带时间戳，用例结束时从废纸篓里清掉。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { apiKey, closeSettings, launch, newChat, openSettings, saveGoogleKey, screens, sendAndWait, setPermission, tempDirs } from './helpers';

const dirs = tempDirs('storage');
const stamp = Date.now();
const fileA = `spark-e2e-storage-a-${stamp}.txt`;
const fileB = `spark-e2e-storage-b-${stamp}.txt`;

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test.afterAll(() => {
  for (const name of [fileA, fileB]) {
    try {
      rmSync(join(homedir(), '.Trash', name), { force: true });
    } catch {
      // 没有访问废纸篓的权限：留着，文件名带 spark-e2e-storage 前缀
    }
  }
});

test('存储页：按会话 / 按分类看占用，清缓存，删会话连同产出一起清；侧栏删除同样清干净', async () => {
  mkdirSync(dirs.workspace, { recursive: true });
  writeFileSync(join(dirs.workspace, 'existing.txt'), 'user file');
  const { app, page } = await launch(dirs);
  await saveGoogleKey(page);

  // 会话 A：新建 fileA，并修改原有的 existing.txt
  await newChat(page);
  await setPermission(page, '自动');
  await sendAndWait(
    page,
    `依次做两件事，不要做别的：1. 用 write_file 创建 ${fileA}，内容 alpha；2. 用 edit_file 把 existing.txt 里的 user 改成 agent。完成后只回复「甲完成」。`,
  );
  await expect(page.getByTestId('timeline')).toContainText('甲完成');
  // 会话 B：新建 fileB
  await newChat(page);
  await setPermission(page, '自动');
  await sendAndWait(page, `用 write_file 创建 ${fileB}，内容 beta。完成后只回复「乙完成」，不要做别的。`);
  await expect(page.getByTestId('timeline')).toContainText('乙完成');
  expect(existsSync(join(dirs.workspace, fileA))).toBe(true);
  expect(existsSync(join(dirs.workspace, fileB))).toBe(true);

  // ── 设置 → 存储 ──
  await openSettings(page, '存储');
  const dialog = page.getByRole('dialog');
  const rows = dialog.locator('[data-testid^="storage-row-"]');
  await expect(rows).toHaveCount(2);
  const rowA = rows.filter({ hasText: fileA });
  const rowB = rows.filter({ hasText: fileB });
  const idOf = async (row: typeof rowA) => ((await row.getAttribute('data-testid')) ?? '').replace('storage-row-', '');
  const idA = await idOf(rowA);
  const idB = await idOf(rowB);
  expect(idA).not.toBe('');
  const runtimeA = join(dirs.userData, 'runtime', idA);
  const runtimeB = join(dirs.userData, 'runtime', idB);
  // 每轮开跑前同步的技能副本就是缓存
  expect(readdirSync(join(runtimeA, 'skills')).length).toBeGreaterThan(0);
  await expect(dialog.getByTestId('storage-total')).not.toHaveText('0 B');

  // 展开 A：明细里产出文件 1 项
  await rowA.getByRole('button', { name: '展开明细' }).click();
  await expect(rowA).toContainText('产出文件');
  await expect(rowA.locator('dl > div').filter({ hasText: '产出文件' })).toContainText('1 项');
  await page.screenshot({ path: join(screens, '90-storage-conversations.png') });

  // 按分类
  await dialog.getByRole('tab', { name: '按分类' }).click();
  await expect(dialog.getByTestId('storage-category-skills')).toContainText('技能副本');
  await dialog.getByTestId('storage-category-outputs').getByRole('button', { name: '展开明细' }).click();
  await expect(dialog.getByTestId('storage-category-outputs')).toContainText(fileA);
  await page.screenshot({ path: join(screens, '91-storage-categories.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(screens, '92-storage-categories-dark.png') });
  await dialog.getByRole('tab', { name: '按会话' }).click();
  await page.screenshot({ path: join(screens, '93-storage-conversations-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // 清 B 的缓存：技能副本没了，会话和它的文件还在
  await rowB.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '清除缓存' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('清除缓存？');
  await page.getByTestId('storage-confirm').click();
  await expect(page.getByText(/^已释放 /)).toBeVisible();
  await expect.poll(() => existsSync(join(runtimeB, 'skills'))).toBe(false);
  await expect(rows).toHaveCount(2);
  await expect(rowB).toContainText('缓存 0 B');
  expect(existsSync(join(dirs.workspace, fileB))).toBe(true);

  // 勾选 A → 删除所选：确认框说明 1 个产出文件进废纸篓
  await rowA.getByRole('checkbox').click();
  await dialog.getByTestId('storage-delete-selected').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('删除 1 个会话？');
  await expect(confirm.getByTestId('storage-confirm-outputs')).toContainText('1 个产出文件');
  await page.screenshot({ path: join(screens, '94-storage-delete-confirm.png') });
  await page.getByTestId('storage-confirm').click();
  await expect(page.getByText('已删除 1 个会话')).toBeVisible();
  await expect(rows).toHaveCount(1);
  // A 新建的文件进了废纸篓；它只是改过的原有文件、B 的文件都还在；A 的运行目录没了
  await expect.poll(() => existsSync(join(dirs.workspace, fileA))).toBe(false);
  expect(existsSync(join(dirs.workspace, 'existing.txt'))).toBe(true);
  expect(existsSync(join(dirs.workspace, fileB))).toBe(true);
  expect(existsSync(runtimeA)).toBe(false);
  expect(existsSync(runtimeB)).toBe(true);
  await closeSettings(page);
  const nav = page.getByRole('navigation', { name: '会话' });
  await expect(nav).not.toContainText(fileA);

  // ── 侧栏删除 B：同一套清理 ──
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('产出文件会移到废纸篓');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', 'home');
  await expect.poll(() => existsSync(join(dirs.workspace, fileB))).toBe(false);
  expect(existsSync(runtimeB)).toBe(false);
  expect(existsSync(join(dirs.workspace, 'existing.txt'))).toBe(true);

  // 存储页现在是空的
  await openSettings(page, '存储');
  await expect(dialog.getByText('还没有会话。')).toBeVisible();
  await app.close();
});
