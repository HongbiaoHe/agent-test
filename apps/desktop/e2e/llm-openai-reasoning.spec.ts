/**
 * OpenAI 推理模型的思考摘要（本机假的 Responses API 服务，总是跑）：
 * - 测模型：默认请求 `reasoning.summary`，能力设置里「显示思考摘要」勾着；
 * - 对话：流式摘要事件显示在思考行里（思考用时 + 摘要首行），回复照常；
 * - 服务端改成「组织未验证、不能要摘要」→ 再测模型自动关掉摘要（能力设置里取消勾选），之后的对话不再请求摘要、照常回复。
 * 截图写到 test-results/screens/llm-openai-*.png。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { z } from 'zod';
import {
  addConnection,
  closeConnectionSheet,
  closeSettings,
  connectionSheet,
  enableModel,
  launch,
  newChat,
  openSettings,
  screens,
  sendAndWait,
  setDefaultModel,
  tempDirs,
} from './helpers';

const MODEL = 'gpt-5.6-luna';
const SUMMARY = '先想想要怎么回答。';
const requestBody = z.object({
  stream: z.boolean().optional(),
  reasoning: z.object({ summary: z.string().optional(), effort: z.string().optional() }).optional(),
});
type RequestBody = z.infer<typeof requestBody>;

/** 假的 OpenAI：GET /v1/models；POST /v1/responses（非流式 = 测模型发起 ping；流式 = 摘要 + 文字回复） */
function startFakeOpenAI(state: { unverified: boolean; requests: RequestBody[] }): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        json(404, { error: { message: 'not found' } });
        return;
      }
      const body = requestBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      state.requests.push(body);
      const wantsSummary = !!body.reasoning?.summary;
      if (wantsSummary && state.unverified) {
        json(400, {
          error: {
            message: 'Your organization must be verified to generate reasoning summaries.',
            type: 'invalid_request_error',
            param: 'reasoning.summary',
            code: 'unsupported_value',
          },
        });
        return;
      }
      const n = state.requests.length;
      if (!body.stream) {
        json(200, {
          id: `resp_${n}`,
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: MODEL,
          output: [
            { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'ping', arguments: '{"value":"ok"}', status: 'completed' },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      const reply = wantsSummary ? '带摘要的回复' : '不带摘要的回复';
      const reasoning = { type: 'reasoning', id: `rs_${n}`, summary: wantsSummary ? [{ type: 'summary_text', text: SUMMARY }] : [] };
      const message = {
        type: 'message',
        id: `msg_${n}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: reply, annotations: [] }],
      };
      const response = {
        id: `resp_${n}`,
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: MODEL,
        output: [reasoning, message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let seq = 0;
      const ev = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      ev('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      ev('response.output_item.added', { output_index: 0, item: { ...reasoning, summary: [] } });
      if (wantsSummary) {
        const ids = { output_index: 0, item_id: reasoning.id, summary_index: 0 };
        ev('response.reasoning_summary_part.added', { ...ids, part: { type: 'summary_text', text: '' } });
        for (const delta of ['先想想', '要怎么回答。']) ev('response.reasoning_summary_text.delta', { ...ids, delta });
        ev('response.reasoning_summary_text.done', { ...ids, text: SUMMARY });
      }
      ev('response.output_item.done', { output_index: 0, item: reasoning });
      ev('response.output_item.added', { output_index: 1, item: { ...message, content: [] } });
      ev('response.output_text.delta', { output_index: 1, item_id: message.id, content_index: 0, delta: reply });
      ev('response.output_item.done', { output_index: 1, item: message });
      ev('response.completed', { response });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('OpenAI 推理模型：思考摘要显示在思考行里；组织未验证时测模型自动关掉摘要、对话照常', async () => {
  test.setTimeout(240_000);
  const state = { unverified: false, requests: [] as RequestBody[] };
  const server = await startFakeOpenAI(state);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const dirs = tempDirs('llm-openai');
  const { app, page } = await launch(dirs);
  try {
    const sheet = await addConnection(page, { preset: 'OpenAI', baseUrl, apiKey: 'sk-local-test' });
    await enableModel(sheet, MODEL);
    const row = sheet.locator(`[data-testid="model-row"][data-model-id="${MODEL}"]`);
    /** 点测试并等它真正跑完（按钮测试中置灰；上一次的结果在测试期间仍显示，不能只看 data-status） */
    const testModel = async (requests: number) => {
      const before = state.requests.length;
      const button = row.getByRole('button', { name: `测试 ${MODEL}` });
      await button.click();
      await expect.poll(() => state.requests.length - before, { timeout: 60_000 }).toBe(requests);
      await expect(button).toBeEnabled({ timeout: 60_000 });
      await expect(row.getByTestId('model-test-result')).toHaveAttribute('data-status', 'ok');
      return state.requests.slice(before).map((r) => r.reasoning ?? null);
    };
    const summaryCheckbox = async () => {
      await row.getByRole('button', { name: `设置 ${MODEL} 的能力` }).click();
      const caps = page.getByRole('dialog', { name: `模型能力：${MODEL}` });
      return { caps, checkbox: caps.getByRole('checkbox', { name: '显示思考摘要' }) };
    };

    // 1) 测模型：请求带摘要，能力设置里默认勾着
    expect(await testModel(1)).toEqual([{ summary: 'auto' }]);
    let { caps, checkbox } = await summaryCheckbox();
    await expect(checkbox).toBeChecked();
    await page.waitForTimeout(500); // 等弹窗入场动画结束再截图
    await page.screenshot({ path: join(screens, 'llm-openai-1-capabilities.png') });
    await caps.getByRole('button', { name: '取消' }).click();
    await closeConnectionSheet(page);
    await setDefaultModel(page, MODEL);
    await closeSettings(page);

    // 2) 对话：摘要逐段推送，结束后思考行显示「思考用时」+ 摘要首行
    await newChat(page);
    await sendAndWait(page, '你好');
    const timeline = page.getByTestId('timeline');
    await expect(timeline).toContainText('带摘要的回复');
    await expect(timeline).toContainText('思考用时');
    await expect(timeline).toContainText(SUMMARY);
    expect(state.requests.at(-1)).toMatchObject({ stream: true, reasoning: { summary: 'auto' } });
    await page.screenshot({ path: join(screens, 'llm-openai-2-chat-summary.png') });

    // 3) 组织未验证：再测模型 → 自动关掉摘要
    state.unverified = true;
    await openSettings(page, '模型');
    await page.getByTestId('llm-connection-card').filter({ hasText: 'OpenAI' }).click();
    await expect(connectionSheet(page)).toBeVisible();
    await connectionSheet(page).getByRole('textbox', { name: '搜索模型' }).fill(MODEL);
    expect(await testModel(2)).toEqual([{ summary: 'auto' }, null]);
    ({ caps, checkbox } = await summaryCheckbox());
    await expect(checkbox).not.toBeChecked();
    await caps.getByRole('button', { name: '取消' }).click();
    await closeConnectionSheet(page);
    await closeSettings(page);

    // 4) 之后的对话不再请求摘要、照常回复
    await sendAndWait(page, '再说一次');
    await expect(timeline).toContainText('不带摘要的回复');
    expect(state.requests.at(-1)?.reasoning ?? null).toBeNull();
    await page.screenshot({ path: join(screens, 'llm-openai-3-chat-no-summary.png') });
  } finally {
    await app.close();
    server.close();
  }
});
