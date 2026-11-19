/**
 * API 连接与模型（设置 → 模型）：
 * - 不联网（总是跑）：没有可用模型时首页 / 对话里引导去添加 API 连接、发送按钮置灰；
 *   Ollama 预设预填 http://localhost:11434/v1、不要求 Key，保存后自动拉取失败（本机没装 Ollama）并内联报错；
 *   手动添加模型 id 后引导消失。
 * - 本机假的 OpenAI 兼容服务（总是跑）：300+ 个模型的长列表可搜索、一键启用筛选结果；刷新后新出现的标「新」、
 *   没再拉到的标「已下架」并可移除；逐个测试显示 支持工具 / 只能对话 / 失败；能力设置保存后再打开仍在；浅色 / 深色截图。
 * - 真实模型（需要 SPARK_E2E_GOOGLE_API_KEY）：添加 Gemini 连接 → 拉到的列表可搜索 → 启用模型 → 测试（支持工具调用）
 *   → 设为默认 → 新对话按分组的模型下拉选中它并拿到回复。
 * 每个用例自建临时目录。截图写到 test-results/screens/llm-*.png。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  addConnection,
  apiKey,
  closeConnectionSheet,
  closeSettings,
  connectionSheet,
  E2E_MODEL,
  enableModel,
  launch,
  newChat,
  openSettings,
  screens,
  sendAndWait,
  setDefaultModel,
  tempDirs,
} from './helpers';

test('没有可用模型时引导添加连接；Ollama 预设免 Key、拉取失败内联报错、手动添加模型', async () => {
  const dirs = tempDirs('llm-local');
  const { app, page } = await launch(dirs);
  try {
    // 首页：没有模型 → 引导按钮
    await expect(page.getByRole('button', { name: '先添加一个 API 连接' })).toBeVisible({ timeout: 20_000 });

    // 对话里：输入框上方提示 + 发送置灰
    await newChat(page);
    const notice = page.getByTestId('no-models-notice');
    await expect(notice).toContainText('先添加一个 API 连接');
    await page.getByLabel('消息').fill('你好');
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    await page.screenshot({ path: join(screens, 'llm-1-no-models.png') });

    // 提示里的按钮直达设置 → 模型
    await notice.getByRole('button', { name: '打开模型设置' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: '模型', exact: true })).toBeVisible();
    await expect(page.getByText('还没有 API 连接')).toBeVisible();

    // Ollama 预设：预填本地地址，Key 可选（不填也能保存）
    await page.getByRole('button', { name: '添加连接' }).click();
    const dialog = page.getByRole('dialog', { name: '添加 API 连接' });
    await dialog.getByRole('combobox', { name: '服务商' }).click();
    await page.getByRole('option', { name: 'Ollama', exact: true }).click();
    await expect(dialog.getByLabel('Base URL')).toHaveValue('http://localhost:11434/v1');
    await expect(dialog.getByLabel('名称')).toHaveValue('Ollama');
    await expect(dialog.getByLabel('API Key（可选）')).toHaveValue('');
    await expect(dialog).toContainText('协议：OpenAI 兼容');
    await expect(dialog.getByRole('button', { name: '保存并拉取模型' })).toBeEnabled();
    await page.screenshot({ path: join(screens, 'llm-2-add-ollama.png') });
    await dialog.getByRole('button', { name: '保存并拉取模型' }).click();
    await expect(dialog).toBeHidden({ timeout: 90_000 });

    // 自动拉取失败（没有 Ollama 在跑）：详情里内联显示原始错误；连接照样建好
    const sheet = page.getByTestId('llm-connection-sheet');
    await expect(sheet.getByTestId('refresh-error')).toContainText('拉取模型列表失败');
    await expect(sheet.getByText('还没有模型')).toBeVisible();

    // 手动添加模型 id（默认启用）
    await sheet.getByRole('textbox', { name: '手动添加模型' }).fill('llama3:8b');
    await sheet.getByRole('button', { name: '添加', exact: true }).click();
    const checkbox = sheet.getByRole('checkbox', { name: '启用 llama3:8b', exact: true });
    await expect(checkbox).toBeChecked();
    await expect(sheet.getByTestId('model-row').filter({ hasText: 'llama3:8b' })).toContainText('手动添加');
    await page.screenshot({ path: join(screens, 'llm-3-ollama-sheet.png') });
    await closeConnectionSheet(page);

    // 卡片：协议 / 无需 Key / 计数
    const card = page.getByTestId('llm-connection-card').filter({ hasText: 'Ollama' });
    await expect(card).toContainText('OpenAI 兼容');
    await expect(card).toContainText('无需 Key');
    await expect(card).toContainText('已启用 1 / 共 1 个模型');
    await closeSettings(page);

    // 有了已启用的模型：引导消失，模型下拉里按连接分组出现它
    await expect(notice).toBeHidden();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /^模型：/ }).click();
    const list = page.getByRole('listbox', { name: '模型' });
    await expect(list.getByRole('group', { name: 'Ollama' })).toBeVisible();
    await expect(list.getByRole('option', { name: /llama3:8b/ })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

/**
 * 本机假的 OpenAI 兼容服务：GET /v1/models 返回 models（可在用例里改）；POST /v1/chat/completions
 * 按模型名回：alpha-chat 发起 ping 工具调用、beta-chat 只回文字、其它 400。
 */
function startFakeProvider(models: { ids: string[] }): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(200, { object: 'list', data: models.ids.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const model = typeof body === 'object' && body !== null && 'model' in body ? String(body.model) : '';
        if (model !== 'alpha-chat' && model !== 'beta-chat') {
          json(400, { error: { message: `The model ${model} does not exist`, type: 'invalid_request_error' } });
          return;
        }
        const message =
          model === 'alpha-chat'
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"value":"ok"}' } }],
              }
            : { role: 'assistant', content: 'ok' };
        json(200, {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model,
          choices: [{ index: 0, message, finish_reason: model === 'alpha-chat' ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** 截图前切浅色 / 深色并等 <html> 的 .dark 跟上 */
async function setScheme(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);
  // 侧拉 / 弹窗 / 输入框带 transition：等背景色过渡完再截图（否则截到半亮半暗）
  await page.waitForTimeout(500);
}

test('自定义 OpenAI 兼容服务：长列表搜索与批量启用、新 / 已下架标记、逐个测试、能力设置', async () => {
  const bulk = Array.from({ length: 300 }, (_, i) => `bulk-model-${String(i).padStart(3, '0')}`);
  const models = { ids: ['alpha-chat', 'beta-chat', 'gamma-old', ...bulk] };
  const server = await startFakeProvider(models);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const dirs = tempDirs('llm-custom');
  const { app, page } = await launch(dirs);
  try {
    const sheet = await addConnection(page, { preset: '自定义', baseUrl, apiKey: 'sk-local-test' });
    await expect(sheet.getByTestId('refresh-error')).toHaveCount(0);
    const summary = sheet.getByTestId('model-summary');
    await expect(summary).toHaveText('已启用 0 / 共 303');
    // 第一次拉到的不标「新」
    await expect(sheet.getByText('新', { exact: true })).toHaveCount(0);

    // 搜索 → 一键启用筛选结果（bulk-model-010 ~ 019）
    const search = sheet.getByRole('textbox', { name: '搜索模型' });
    await search.fill('bulk-model-01');
    await expect(sheet.getByTestId('model-row')).toHaveCount(10);
    await sheet.getByRole('button', { name: '启用筛选出的 10 个' }).click();
    await expect(summary).toHaveText('已启用 10 / 共 303');

    // 启用三个对话模型
    await search.fill('');
    for (const id of ['alpha-chat', 'beta-chat', 'gamma-old']) await enableModel(sheet, id);
    await search.fill('');
    await expect(summary).toHaveText('已启用 13 / 共 303');

    // 「只看已启用」
    await sheet.getByRole('switch').click();
    await expect(sheet.getByTestId('model-row')).toHaveCount(13);
    await sheet.getByRole('switch').click();

    // 逐个测试：支持工具 / 只能对话 / 失败（带服务端原始错误）
    const row = (id: string) => sheet.locator(`[data-testid="model-row"][data-model-id="${id}"]`);
    await search.fill('-chat');
    for (const id of ['alpha-chat', 'beta-chat']) await row(id).getByRole('button', { name: `测试 ${id}` }).click();
    await expect(row('alpha-chat').getByTestId('model-test-result')).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
    await expect(row('alpha-chat')).toContainText('支持工具调用');
    await expect(row('beta-chat').getByTestId('model-test-result')).toHaveAttribute('data-status', 'no_tools', {
      timeout: 60_000,
    });
    await expect(row('beta-chat')).toContainText('只能对话，不支持工具调用');
    await search.fill('gamma');
    await row('gamma-old').getByRole('button', { name: '测试 gamma-old' }).click();
    await expect(row('gamma-old').getByTestId('model-test-result')).toHaveAttribute('data-status', 'error', {
      timeout: 60_000,
    });
    await expect(row('gamma-old')).toContainText('does not exist');

    // 服务那边下架 gamma-old、上新 delta-new → 刷新：标「已下架」/「新」，启用状态不变
    models.ids = models.ids.filter((id) => id !== 'gamma-old').concat('delta-new');
    await sheet.getByRole('button', { name: '刷新模型列表' }).click();
    await search.fill('a-');
    await expect(row('gamma-old')).toContainText('已下架');
    await expect(row('gamma-old').getByRole('checkbox')).toBeChecked();
    await expect(row('delta-new')).toContainText('新');
    await expect(row('delta-new').getByRole('checkbox')).not.toBeChecked();
    await setScheme(page, 'light');
    await page.screenshot({ path: join(screens, 'llm-7-model-list-light.png') });
    await setScheme(page, 'dark');
    await page.screenshot({ path: join(screens, 'llm-7-model-list-dark.png') });
    await setScheme(page, 'light');

    // 已下架的可以移除
    await row('gamma-old').getByRole('button', { name: '移除 gamma-old' }).click();
    await expect(row('gamma-old')).toHaveCount(0);

    // 能力设置：换写法 → 档位跟着换；填上下文窗口；保存后再打开仍在
    await search.fill('alpha');
    await row('alpha-chat').getByRole('button', { name: '设置 alpha-chat 的能力' }).click();
    let caps = page.getByRole('dialog', { name: '模型能力：alpha-chat' });
    await caps.getByRole('combobox', { name: '思考参数写法' }).click();
    await page.getByRole('option', { name: /^thinking\.type 开关/ }).click();
    await expect(caps.getByRole('checkbox', { name: '开启' })).toBeChecked();
    await expect(caps.getByRole('checkbox', { name: '高' })).toHaveCount(0);
    await caps.getByRole('checkbox', { name: '关闭' }).click();
    await caps.getByLabel('上下文窗口（token）').fill('128000');
    await page.screenshot({ path: join(screens, 'llm-8-capabilities-light.png') });
    await setScheme(page, 'dark');
    await page.screenshot({ path: join(screens, 'llm-8-capabilities-dark.png') });
    await setScheme(page, 'light');
    await caps.getByRole('button', { name: '保存' }).click();
    await expect(caps).toBeHidden();
    await row('alpha-chat').getByRole('button', { name: '设置 alpha-chat 的能力' }).click();
    caps = page.getByRole('dialog', { name: '模型能力：alpha-chat' });
    await expect(caps.getByRole('combobox', { name: '思考参数写法' })).toContainText('thinking.type');
    await expect(caps.getByRole('checkbox', { name: '关闭' })).not.toBeChecked();
    await expect(caps.getByRole('checkbox', { name: '开启' })).toBeChecked();
    await expect(caps.getByLabel('上下文窗口（token）')).toHaveValue('128000');
    await caps.getByRole('button', { name: '取消' }).click();

    // 连接设置页签：协议只读，改名后卡片跟着变
    await sheet.getByRole('tab', { name: '连接设置' }).click();
    await expect(sheet).toContainText('协议创建后不能修改');
    await sheet.getByLabel('名称').fill('本机假服务');
    await sheet.getByRole('button', { name: '保存修改' }).click();
    await expect(sheet.getByRole('heading')).toContainText('本机假服务');
    await page.screenshot({ path: join(screens, 'llm-9-connection-settings.png') });
    await closeConnectionSheet(page);
    await expect(page.getByTestId('llm-connection-card')).toContainText('本机假服务');
    await expect(page.getByTestId('llm-connection-card')).toContainText('Key 已配置');

    // 再加一个 Ollama 连接（手动模型），模型下拉按连接分组
    await addConnection(page, { preset: 'Ollama' });
    await connectionSheet(page).getByRole('textbox', { name: '手动添加模型' }).fill('llama3:8b');
    await connectionSheet(page).getByRole('button', { name: '添加', exact: true }).click();
    await expect(connectionSheet(page).getByRole('checkbox', { name: '启用 llama3:8b', exact: true })).toBeChecked();
    await closeConnectionSheet(page);
    await setDefaultModel(page, 'alpha-chat');
    await setScheme(page, 'light');
    await page.screenshot({ path: join(screens, 'llm-10-connections-light.png') });
    await setScheme(page, 'dark');
    await page.screenshot({ path: join(screens, 'llm-10-connections-dark.png') });
    await setScheme(page, 'light');
    await closeSettings(page);

    // 对话：默认 alpha-chat；下拉两组、可搜索；alpha 的能力里有思考档位「开启」
    await newChat(page);
    const switcher = page.getByRole('button', { name: '模型：alpha-chat' });
    await expect(switcher).toBeVisible();
    await page.getByRole('button', { name: '思考深度' }).click();
    await expect(page.getByRole('option', { name: /^开启/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /^高/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option', { name: /^开启/ })).toHaveCount(0);
    await switcher.click();
    const list = page.getByRole('listbox', { name: '模型' });
    await expect(list.getByRole('group', { name: '本机假服务' })).toBeVisible();
    await expect(list.getByRole('group', { name: 'Ollama' })).toBeVisible();
    // beta-chat 测过「只能对话」：带警告标记
    await expect(list.getByRole('option', { name: /beta-chat/ }).getByRole('img', { name: '测试显示不支持工具调用' })).toBeVisible();
    await page.waitForTimeout(500); // 等浮层入场动画结束再截图
    await page.screenshot({ path: join(screens, 'llm-11-switcher-light.png') });
    await setScheme(page, 'dark');
    await page.screenshot({ path: join(screens, 'llm-11-switcher-dark.png') });
    await setScheme(page, 'light');
    await page.getByRole('textbox', { name: '搜索模型…' }).fill('llama');
    await expect(list.getByRole('group', { name: '本机假服务' })).toHaveCount(0);
    await list.getByRole('option', { name: /llama3:8b/ }).click();
    await expect(page.getByRole('button', { name: '模型：llama3:8b' })).toBeVisible();
  } finally {
    await app.close();
    server.close();
  }
});

test('真实模型：添加 Gemini 连接 → 搜索并启用 → 测试 → 设默认 → 对话拿到回复', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');
  const dirs = tempDirs('llm-live');
  const { app, page } = await launch(dirs);
  try {
    const sheet = await addConnection(page, { preset: 'Google Gemini', apiKey });
    await expect(sheet.getByTestId('refresh-error')).toHaveCount(0);

    // 拉到的列表可以搜索：搜 E2E_MODEL 只剩含它的项
    const rows = sheet.getByTestId('model-row');
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(1);
    const total = await rows.count();
    await enableModel(sheet, E2E_MODEL);
    const filtered = await rows.count();
    expect(filtered).toBeLessThan(total);
    for (const id of await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-model-id') ?? ''))) {
      expect(id).toContain(E2E_MODEL);
    }

    // 测试：带工具的最小请求 → 支持工具调用
    const row = sheet.locator(`[data-testid="model-row"][data-model-id="${E2E_MODEL}"]`);
    await row.getByRole('button', { name: `测试 ${E2E_MODEL}` }).click();
    const result = row.getByTestId('model-test-result');
    await expect(result).toHaveAttribute('data-status', 'ok', { timeout: 90_000 });
    await expect(result).toContainText('支持工具调用');
    await page.screenshot({ path: join(screens, 'llm-4-gemini-tested.png') });

    // 测试连接：不耗 token，返回模型数
    await sheet.getByRole('button', { name: '测试连接' }).click();
    await expect(sheet.getByTestId('connection-test-result')).toContainText('连接正常', { timeout: 60_000 });

    // 能力设置：Gemini 写法 + 档位
    await row.getByRole('button', { name: `设置 ${E2E_MODEL} 的能力` }).click();
    const caps = page.getByRole('dialog', { name: `模型能力：${E2E_MODEL}` });
    await expect(caps.getByRole('combobox', { name: '思考参数写法' })).toContainText('Gemini thinkingConfig');
    await expect(caps.getByRole('checkbox', { name: '高' })).toBeVisible();
    await page.screenshot({ path: join(screens, 'llm-5-capabilities.png') });
    await caps.getByRole('button', { name: '取消' }).click();
    await expect(caps).toBeHidden();

    await closeConnectionSheet(page);
    await setDefaultModel(page, E2E_MODEL);
    await closeSettings(page);

    // 新对话：默认就是它；下拉按连接分组、可搜索
    await newChat(page);
    await expect(page.getByRole('button', { name: `模型：${E2E_MODEL}` })).toBeVisible();
    await page.getByRole('button', { name: `模型：${E2E_MODEL}` }).click();
    const list = page.getByRole('listbox', { name: '模型' });
    await expect(list.getByRole('group', { name: 'Google Gemini' })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索模型…' }).fill('zzz-no-such-model');
    await expect(list).toContainText('没有匹配的模型');
    await page.getByRole('textbox', { name: '搜索模型…' }).fill(E2E_MODEL);
    await expect(list.getByRole('option', { name: new RegExp(E2E_MODEL) })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    await sendAndWait(page, '只回复四个字：连接成功');
    await expect(page.getByTestId('timeline')).toContainText('连接成功');
    await page.screenshot({ path: join(screens, 'llm-6-chat.png') });

    // 设置里能看到 Key 已配置、计数
    await openSettings(page, '模型');
    await expect(page.getByTestId('llm-connection-card').filter({ hasText: 'Google Gemini' })).toContainText('Key 已配置');
    await closeSettings(page);
  } finally {
    await app.close();
  }
});
