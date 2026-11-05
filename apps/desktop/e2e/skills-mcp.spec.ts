/**
 * 计划 C 的端到端（真实模型）：
 * - 技能：内置 create-skills 在列；从文件夹导入 → 同步进会话运行目录 → /技能名 调用；/skills add 从 GitHub 安装；
 * - 附件：选文件 → 复制进运行目录 → 技能里用 execute 读它（自动档位：不弹审批）；
 * - MCP：本地 Streamable HTTP server → 界面添加并连接 → agent 调用工具；MCP App 卡片在 spark-mcp:// 沙箱里渲染并回调工具。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, test } from '@playwright/test';
import {
  apiKey,
  launch,
  newChat,
  closeSettings,
  openSettings,
  saveGoogleKey,
  screens,
  sendAndWait,
  setPermission,
  stubOpenDialog,
  tempDirs,
} from './helpers';

const dirs = tempDirs('skills-mcp');

/** 最小 MCP App（不依赖 SDK，手写 JSON-RPC）：握手 → 显示工具结果 → 再由卡片自己调一次 get_secret */
const CARD_HTML = `<!doctype html><html><body>
<div id="out">waiting</div><div id="call"></div>
<script>
let seq = 0; const pending = {};
function req(method, params) {
  return new Promise((resolve) => { const id = ++seq; pending[id] = resolve; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*'); });
}
const text = (r) => ((r && r.content) || []).map((c) => c.text).join('');
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (m.id && !m.method && pending[m.id]) { pending[m.id](m.result || m.error); delete pending[m.id]; return; }
  if (m.method === 'ui/notifications/tool-result') {
    document.getElementById('out').textContent = 'APP-RESULT:' + text(m.params);
    req('tools/call', { name: 'get_secret', arguments: {} }).then((r) => {
      document.getElementById('call').textContent = 'APP-CALL:' + text(r);
    });
  }
  if (m.method && m.id) parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
});
req('ui/initialize', { appInfo: { name: 'e2e-card', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
  .then(() => parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'));
</script></body></html>`;

/** 无状态 MCP server：每个请求新建 server + transport（SDK 的 stateless 用法） */
function startMcpServer(): Promise<Server> {
  const http = createServer((req, res) => {
    void (async () => {
      const server = new McpServer({ name: 'e2e-mcp', version: '1.0.0' });
      server.registerTool(
        'get_secret',
        { description: '返回一个测试用的密语', annotations: { readOnlyHint: true } },
        () => ({ content: [{ type: 'text', text: 'mcp-secret-99' }] }),
      );
      server.registerTool(
        'show_card',
        {
          description: '展示一张交互卡片',
          annotations: { readOnlyHint: true },
          _meta: { ui: { resourceUri: 'ui://e2e/card' } },
        },
        () => ({ content: [{ type: 'text', text: 'card-data-77' }] }),
      );
      server.registerResource(
        'e2e-card',
        'ui://e2e/card',
        { mimeType: 'text/html;profile=mcp-app' },
        (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: CARD_HTML }] }),
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

test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');

test('技能安装与调用、附件、MCP 工具与 App 卡片、/skills add', async () => {
  // 准备：一个技能文件夹 + 一个附件
  const skillDir = join(dirs.root, 'magic-echo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: magic-echo',
      'description: 用户输入 /magic-echo 时使用：用命令读出用户附件并按固定格式回复',
      '---',
      '被调用时严格按以下步骤：',
      '1. 用 execute 运行 `cat <附件路径>` 读出用户消息「[附件]」里列出的附件；',
      '2. 回复且只回复一行：MAGIC-ECHO-42 后接一个空格，再接附件全文。',
    ].join('\n'),
  );
  const attachment = join(dirs.root, 'note.txt');
  writeFileSync(attachment, 'attachment-secret-7');
  const mcp = await startMcpServer();
  const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;

  const { app, page } = await launch(dirs);
  // ext-apps 的告警与卡片拆除（重复握手 / 意外重建时会出现）：卡片断言失败时便于判断断在哪一层
  page.on('console', (m) => {
    if (/\[ext-apps\]|resource-teardown/.test(m.text())) console.log('[card]', m.text());
  });
  await saveGoogleKey(page);

  // 设置 → 技能：内置 create-skills 在列；从文件夹导入 magic-echo
  await openSettings(page, '技能');
  await expect(page.getByText('create-skills', { exact: true })).toBeVisible();
  await stubOpenDialog(app, [skillDir]);
  await page.getByRole('button', { name: 'Import folder' }).click();
  await expect(page.getByText('magic-echo', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(screens, '5-skills.png') });

  // 设置 → 连接器：添加本地 server 并连接（Web 同款对话框）
  await openSettings(page, '连接器');
  await page.getByRole('button', { name: 'Add connector' }).click();
  await page.getByPlaceholder("Optional — defaults to the server's own name").fill('e2e');
  await page.getByPlaceholder('https://example.com/mcp').fill(mcpUrl);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/2 tools/)).toBeVisible();
  await page.screenshot({ path: join(screens, '6-mcp.png') });
  await closeSettings(page);

  // 对话 1（自动档位）：/magic-echo + 附件；技能与附件都在运行目录，不写进工作区
  await newChat(page);
  await setPermission(page, 'Auto');
  await stubOpenDialog(app, [attachment]);
  await page.getByRole('button', { name: 'Attach files' }).click();
  await expect(page.getByRole('list', { name: 'Pending attachments' })).toContainText('note.txt');
  await sendAndWait(page, '/magic-echo 处理一下附件', { approve: false });
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('MAGIC-ECHO-42');
  await expect(timeline).toContainText('attachment-secret-7');
  await expect(page.getByTestId('approval-panel')).toHaveCount(0);
  expect(existsSync(join(dirs.workspace, 'skills'))).toBe(false);
  expect(existsSync(join(dirs.workspace, 'attachments'))).toBe(false);
  await page.screenshot({ path: join(screens, '7-skill-attachment.png') });

  // 对话 2：调用 MCP 工具（只读工具默认自动允许）
  await newChat(page);
  await sendAndWait(page, '调用 e2e 连接器的 get_secret 工具，把它返回的内容原样告诉我。');
  await expect(page.getByTestId('timeline')).toContainText('mcp-secret-99');
  await page.screenshot({ path: join(screens, '8-mcp-call.png') });

  // 对话 3：MCP App 卡片——在 spark-mcp:// 沙箱里渲染，收到工具结果，并能自己回调工具
  await newChat(page);
  await sendAndWait(page, '调用 e2e 连接器的 show_card 工具，然后只回复「卡片已展示」。');
  const card = page.frameLocator('iframe[title="e2e app"]').frameLocator('iframe');
  await expect(card.getByText('APP-RESULT:card-data-77')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('APP-CALL:mcp-secret-99')).toBeVisible({ timeout: 30_000 });
  const src = await page.locator('iframe[title="e2e app"]').getAttribute('src');
  expect(src).toMatch(/^spark-mcp:\/\/m-[a-f0-9]{16}\//);
  await page.screenshot({ path: join(screens, '8b-mcp-app.png') });

  // /skills add：兼容 npx skills add 写法，直接从 GitHub 装（不经模型）
  await newChat(page);
  await sendAndWait(page, '/skills add anthropics/skills --skill skill-creator');
  await expect(page.getByTestId('timeline')).toContainText('已安装 1 个技能');
  await openSettings(page, '技能');
  await expect(page.getByText('skill-creator', { exact: true })).toBeVisible();

  await app.close();
  mcp.close();
});
