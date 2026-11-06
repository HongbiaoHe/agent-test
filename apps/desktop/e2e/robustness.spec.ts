/**
 * 异常路径（真实模型）：拒绝审批、运行中停止、agent-host 崩溃后自动恢复。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiKey, launch, newChat, saveGoogleKey, screens, sendAndWait, setPermission, tempDirs } from './helpers';

const dirs = tempDirs('robust');

/**
 * 本机还有没有某条命令在跑（用独一无二的 sleep 秒数当标记）。
 * 不经 shell 直接调 pgrep：经 shell 时 sh 自己的命令行里也带着这个模式，会被 pgrep -f 匹配到。
 */
function processAlive(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 现场快照：命令行含该模式的进程（pid / ppid / 命令），断言失败时便于区分「真没杀掉」和「误匹配」 */
function psSnapshot(pattern: string): string {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes(pattern))
    .join('\n');
}

/** 每个用例自给自足：Playwright 在用例失败后会换 worker、重新加载本文件，dirs 就变成新的空目录 */
async function ensureReady(page: Page): Promise<void> {
  const keys = await page.evaluate(() => window.desktop.getKeyStatus());
  if (!keys.google) await saveGoogleKey(page);
}

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('只读档位：写文件被直接拒绝，不弹审批', async () => {
  const { app, page } = await launch(dirs);
  await ensureReady(page);
  await newChat(page);
  await setPermission(page, '只读');
  await sendAndWait(page, '用 write_file 创建 ro-marker.txt，内容 x。如果被拒绝，就只回复「只读拒绝」，不要重试。', {
    approve: false,
  });
  await expect(page.getByTestId('approval-panel')).toHaveCount(0);
  await expect(page.getByTestId('timeline')).toContainText('只读拒绝');
  expect(existsSync(join(dirs.workspace, 'ro-marker.txt'))).toBe(false);
  await app.close();
});

test('拒绝审批：命令不执行，对话正常收尾', async () => {
  const { app, page } = await launch(dirs);
  await ensureReady(page);
  await newChat(page); // 默认「询问」：execute 需要审批
  const input = page.getByLabel('消息');
  await input.fill('用 execute 运行 `touch rejected-marker.txt`。如果被拒绝，就只回复「已取消」，不要做别的。');
  await input.press('Enter');
  const approval = page.getByTestId('approval-panel');
  await expect(approval).toBeVisible({ timeout: 150_000 });
  await approval.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId('timeline')).toContainText('已取消');
  expect(existsSync(join(dirs.workspace, 'rejected-marker.txt'))).toBe(false);
  await page.screenshot({ path: join(screens, '9-rejected.png') });
  await app.close();
});

test('运行中停止：正在执行的命令连同子进程被杀掉', async () => {
  const { app, page } = await launch(dirs);
  await ensureReady(page);
  await newChat(page);
  await setPermission(page, '自动'); // 自动档位：不用审批，直接开跑
  const input = page.getByLabel('消息');
  await input.fill('用 execute 运行 `sleep 97 && echo $((40+2))late`，等它结束后告诉我输出。');
  await input.press('Enter');
  await expect.poll(() => processAlive('sleep 97'), { timeout: 150_000 }).toBe(true);
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText(/已停止，用时/)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  console.log(`停止 1 秒后命令行含 sleep 97 的进程：\n${psSnapshot('sleep 97') || '（无）'}`);
  await expect.poll(() => processAlive('sleep 97'), { timeout: 5_000 }).toBe(false);
  // 命令文本里只有 $((40+2))late，真正执行完才会出现 42late
  await expect(page.getByTestId('timeline')).not.toContainText('42late');
  await page.screenshot({ path: join(screens, '10-stopped.png') });
  await app.close();
});

test('agent-host 崩溃：自动重启，运行中的会话标为中断，之后还能继续对话', async () => {
  const { app, page } = await launch(dirs);
  await ensureReady(page);
  await newChat(page);
  await setPermission(page, '自动');
  const input = page.getByLabel('消息');
  await input.fill('用 execute 运行 `sleep 98`，结束后回复 done。');
  await input.press('Enter');
  await expect.poll(() => processAlive('sleep 98'), { timeout: 150_000 }).toBe(true);

  // 找到 agent-host（utilityProcess 的 metrics.name = fork 时传的 serviceName）并强杀
  const hostPid = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().find((m) => m.name === 'Spark Agent Host')?.pid ?? null,
  );
  expect(hostPid).not.toBeNull();
  process.kill(hostPid as number, 'SIGKILL');

  // main 1 秒后重启 agent-host；新进程启动时把 running 会话标成失败并写「运行中断」
  await expect(page.getByTestId('timeline')).toContainText('运行中断', { timeout: 30_000 });
  await page.screenshot({ path: join(screens, '11-crash-recovered.png') });

  // 崩溃时 stop() 没机会执行，命令进程组成了孤儿：新启动的 agent-host 按登记表清理（ProcessTracker.reapOrphans）
  await expect.poll(() => processAlive('sleep 98'), { timeout: 10_000 }).toBe(false);

  // 重连后能继续对话（新会话：同一会话里模型会把上一轮没跑完的 sleep 98 再跑一遍）
  await newChat(page);
  await sendAndWait(page, '只回复：恢复正常');
  await expect(page.getByTestId('timeline')).toContainText('恢复正常');
  await app.close();
});
