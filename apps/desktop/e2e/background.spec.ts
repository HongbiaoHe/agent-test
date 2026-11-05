/**
 * 后台任务端到端（真实模型）：
 * - watch_until：后台轮询本地 MCP 的 get_job，第 3 次返回 completed → 通知唤醒 agent → 新一轮汇报结果；
 * - run_in_background：长命令出任务卡片，卡片上取消 → 进程组被杀、不唤醒 agent。
 */
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
  setPermission,
  tempDirs,
} from './helpers';

const dirs = tempDirs('background');

/** get_job：前两次 running，之后 completed（计数跨请求保留：stateless server 每次请求新建实例） */
let jobPolls = 0;
function startMcpServer(): Promise<Server> {
  const http = createServer((req, res) => {
    void (async () => {
      const server = new McpServer({ name: 'jobs', version: '1.0.0' });
      server.registerTool(
        'get_job',
        { description: '查询后台作业状态，返回 {"status": ..., "result": ...}', annotations: { readOnlyHint: true } },
        () => {
          jobPolls++;
          const body = jobPolls >= 3 ? { status: 'completed', result: 'job-result-55' } : { status: 'running' };
          return { content: [{ type: 'text', text: JSON.stringify(body) }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    })();
  });
  return new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(http)));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function processAlive(pattern: string): boolean {
  try {
    execFileSync('pgrep', ['-f', pattern], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function ensureKey(page: Page) {
  const keys = await page.evaluate(() => window.desktop.getKeyStatus());
  if (!keys.google) await saveGoogleKey(page);
}

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('watch_until：后台轮询到完成 → 通知唤醒 agent → 汇报结果', async () => {
  const mcp = await startMcpServer();
  const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  const { app, page } = await launch(dirs);
  await ensureKey(page);

  await openSettings(page, '连接器');
  await page.getByRole('button', { name: 'Add connector' }).click();
  await page.getByPlaceholder("Optional — defaults to the server's own name").fill('jobs');
  await page.getByPlaceholder('https://example.com/mcp').fill(mcpUrl);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 });
  await closeSettings(page);

  await newChat(page);
  await sendAndWait(
    page,
    '用 watch_until 在后台轮询 jobs 连接器的 get_job 工具：arguments_json 为 {}，until_path 为 status，done_values 为 ["completed"]，interval_seconds 为 5，标题写「等作业」。不要自己调用 get_job。发起后直接结束本轮；收到任务通知后，只回复通知结果里 result 字段的值。',
  );
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('Watching');
  await expect(timeline).toContainText('等作业');
  await page.screenshot({ path: join(screens, '12-bg-watch-running.png') });

  // 第 3 次轮询完成 → 通知行 → agent 新一轮回复结果
  await expect(timeline).toContainText('Background task finished', { timeout: 60_000 });
  await expect(timeline).toContainText('job-result-55', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 120_000 });
  expect(jobPolls).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: join(screens, '13-bg-watch-done.png') });

  await app.close();
  mcp.close();
});

test('run_in_background：任务卡片上取消 → 进程被杀、不唤醒 agent', async () => {
  const { app, page } = await launch(dirs);
  await ensureKey(page);
  await newChat(page);
  await setPermission(page, 'Auto');
  await sendAndWait(page, '用 run_in_background 运行 `sleep 79 && echo late`，标题写「长任务」。发起后直接结束本轮，不要做别的。');
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('Background command');
  await expect.poll(() => processAlive('sleep 79'), { timeout: 15_000 }).toBe(true);
  await page.screenshot({ path: join(screens, '14-bg-command-running.png') });

  await page.getByRole('button', { name: 'Cancel background task' }).click();
  await expect(timeline).toContainText('Cancelled', { timeout: 10_000 });
  await expect.poll(() => processAlive('sleep 79'), { timeout: 10_000 }).toBe(false);
  // 取消的任务不通知：几秒内不会出现通知行、也不会开新一轮
  await page.waitForTimeout(3000);
  await expect(timeline).not.toContainText('Background task');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await page.screenshot({ path: join(screens, '15-bg-command-cancelled.png') });
  await app.close();
});
