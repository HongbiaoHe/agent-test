/**
 * 画布 agent「看图」端到端：真实本地 Web 后端 + 真实模型，**不触发任何生成**。
 *   SPARK_E2E_WEB_API=http://127.0.0.1:3101 SPARK_E2E_GOOGLE_API_KEY=... SPARK_E2E_REDIS_CONTAINER=agent-test-redis-1 \
 *     pnpm exec playwright test e2e/canvas-inspect.spec.ts
 *
 * 先经 Web 接口给测试账号备好一块画布：两个上传节点，各挂一张**真实**图片（不是 Mock 占位——Mock 素材不做分析）：
 * 一张纯红色方图、一张电视彩条测试卡。然后 desktop 登录同一账号、打开这块画布，在右侧对话栏让本机 agent
 * 检查这两张图画的是什么 → agent 必须调用 inspect_node_media（画布状态里只有节点标题，看不到画面），
 * 回答里说得出两张图的实际内容。图片理解由后端用 Gemini 做（需后端配了 GOOGLE_API_KEY）。
 *
 * 画布没有删除接口：备好的画布按固定标题复用（已挂好两张图就直接用），不每跑一次堆一块新画布；
 * 复用时分析读缓存，不再花分析额度。
 *
 * SPARK_E2E_REDIS_CONTAINER：后端 Redis 容器名。备数据要登录一次、desktop 界面再登录一次，
 * 验证码限流是 60 秒一次，给了容器名就在两次之间清掉限流。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiKey, launch, saveGoogleKey, screens, tempDirs, waitTurn } from './helpers';

const webApi = process.env.SPARK_E2E_WEB_API ?? '';
const redis = process.env.SPARK_E2E_REDIS_CONTAINER ?? '';
const EMAIL = 'e2e-spark-inspect@example.test';
const TITLE = '看图画布（e2e）';

test.skip(
  !apiKey || !webApi || !redis,
  '需要 SPARK_E2E_GOOGLE_API_KEY、SPARK_E2E_WEB_API（本地 Web 后端）、SPARK_E2E_REDIS_CONTAINER',
);

const clearCodeLimit = () => execFileSync('docker', ['exec', redis, 'redis-cli', 'DEL', `auth:code:limit:${EMAIL}`]);

/** Web 后端接口（{ code, message, data } 信封） */
async function api<T>(jwt: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${webApi}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof Uint8Array ? {} : { 'Content-Type': 'application/json' }),
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...init.headers,
    },
  });
  const body = (await res.json()) as { code: number; message: string; data: T };
  if (body.code !== 0) throw new Error(`${path} → ${res.status} ${body.message}`);
  return body.data;
}

/** 一块画布 + 两个挂着真实图片的上传节点（同标题已备好就复用） */
async function prepareCanvas(images: { name: string; file: () => string }[]): Promise<void> {
  const { code } = await api<{ code: string }>(null, '/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL }),
  });
  const { token } = await api<{ token: string }>(null, '/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, code }),
  });
  const { items } = await api<{ items: { id: string; title: string | null }[] }>(token, '/canvas?limit=50');
  const prepared = items.find((c) => c.title === TITLE);
  if (prepared) {
    const snap = await api<{ nodes: { mediaStatus?: string | null }[] }>(token, `/canvas/${prepared.id}`);
    if (snap.nodes.length === images.length && snap.nodes.every((n) => n.mediaStatus === 'done')) return;
  }
  const { sessionId } = await api<{ sessionId: string }>(token, '/canvas', {
    method: 'POST',
    body: JSON.stringify({ title: TITLE }),
  });
  for (const [i, img] of images.entries()) {
    const { revision } = await api<{ revision: number }>(token, `/canvas/${sessionId}`);
    const added = await api<{ patch: { node: { id: string } } }>(token, `/canvas/${sessionId}/ops`, {
      method: 'POST',
      body: JSON.stringify({ baseRevision: revision, op: { op: 'add_node', type: 'image_upload', x: i * 320, y: 0 } }),
    });
    await api(token, `/canvas/${sessionId}/nodes/${added.patch.node.id}/upload?filename=${encodeURIComponent(img.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(readFileSync(img.file())),
    });
  }
}

async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('邮箱地址').fill(EMAIL);
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByLabel('验证码')).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page.getByTestId('sidebar-user')).toHaveText(EMAIL, { timeout: 30_000 });
}

test('画布 agent 检查分镜图：调用 inspect_node_media 拿到画面描述，答得出两张图各是什么', async () => {
  test.setTimeout(420_000);
  const dirs = tempDirs('canvas-inspect');

  // 两张一眼能分辨的真实图片（ffmpeg 现生成，不依赖仓库里的二进制素材；复用已备好的画布时不生成）
  const frame = (name: string, source: string) => () => {
    const file = join(dirs.root, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-frames:v', '1', file]);
    return file;
  };

  clearCodeLimit();
  await prepareCanvas([
    { name: '分镜一.png', file: frame('red.png', 'color=c=red:s=720x720') },
    { name: '分镜二.png', file: frame('bars.png', 'smptebars=s=1280x720') },
  ]);
  clearCodeLimit();

  const { app, page } = await launch(dirs, { skipLogin: false, env: { SPARK_WEB_API_URL: webApi } });
  try {
    await signIn(page);
    await saveGoogleKey(page);

    // 打开备好的画布：两张上传卡片已经挂着图
    await page.getByRole('button', { name: '画布', exact: true }).click();
    // 同标题若有备坏的旧画布，列表按更新时间倒序，最新备好的在前
    await page.getByTestId('canvas-list-item').filter({ hasText: TITLE }).first().click();
    const view = page.getByTestId('canvas-view');
    await expect(view.getByRole('button', { name: TITLE })).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('.react-flow__node')).toHaveCount(2, { timeout: 20_000 });
    await expect(view.locator('.react-flow__node img')).toHaveCount(2, { timeout: 30_000 });

    // 右侧对话栏：让 agent 检查这两张图（只看不改，不要生成）
    const first = page.getByTestId('canvas-first-message');
    await first
      .getByRole('textbox')
      .fill('检查一下画布上「分镜一」「分镜二」这两张图分别画的是什么、有没有问题，用中文简短回答。只看不改，不要新建或修改节点，也不要触发生成，不要问我。');
    await first.getByRole('textbox').press('Enter');
    const panel = page.getByTestId('canvas-chat-panel');
    await expect(panel.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 30_000 });
    const approvals = await waitTurn(page, { approve: false });
    expect(approvals, '只看图不应发起任何需要审批的操作').toBe(0);

    // 回答说得出两张图的实际内容：一张红色、一张彩条测试卡（标题里没有这些信息，只能来自画面描述）
    const answer = panel.getByTestId('timeline');
    await expect(answer).toContainText('红', { timeout: 20_000 });
    await expect(answer).toContainText(/彩条|彩色条|测试卡|测试图|色条|测试信号/);
    await expect(view.locator('.react-flow__node')).toHaveCount(2);
    await page.screenshot({ path: join(screens, 'canvas-inspect-answer.png') });
  } finally {
    await app.close();
  }
});
