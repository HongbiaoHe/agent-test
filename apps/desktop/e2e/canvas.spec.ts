/**
 * 画布（数据在 Web 账号下，与网页端同一批）端到端：真实本地 Web 后端 + 真实模型，**不触发任何生成**。
 *   SPARK_E2E_WEB_API=http://127.0.0.1:3101 SPARK_E2E_GOOGLE_API_KEY=... pnpm exec playwright test e2e/canvas.spec.ts
 * 登录 Web 测试账号 → 侧栏「画布」→ 新建画布 → 改名 → 右侧对话栏发第一条消息（新建对话并绑定画布）→
 * 本机 agent 用共享的画布工具建节点、连线，画布视图实时出现 → 本轮结束运行锁释放 →
 * 普通对话里 agent 新建画布 → 画布在对话右侧的侧栏里实时打开（不带对话栏），卡片可再打开、可展开全部。
 *
 * 硬约束：不点任何 Generate / Merge；权限保持「询问」，agent 若想生成会停在审批上，用例当场失败。
 * SPARK_E2E_REDIS_CONTAINER：后端 Redis 容器名；给了就先清掉测试账号的验证码限流（60 秒一次）。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiKey, launch, newChat, saveGoogleKey, screens, sendAndWait, tempDirs, waitTurn } from './helpers';

const webApi = process.env.SPARK_E2E_WEB_API ?? '';
const EMAIL = 'e2e-spark-canvas@example.test';

test.skip(!apiKey || !webApi, '需要 SPARK_E2E_GOOGLE_API_KEY、SPARK_E2E_WEB_API（本地 Web 后端）');

async function signIn(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '欢迎使用 Spark' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('邮箱地址').fill(EMAIL);
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByLabel('验证码')).toHaveValue(/^\d{6}$/, { timeout: 15_000 });
  await page.getByRole('button', { name: '验证并登录' }).click();
  await expect(page.getByTestId('sidebar-user')).toHaveText(EMAIL, { timeout: 30_000 });
}

test('画布：列表新建 → 改名 → 右侧对话里本机 agent 建节点连线（实时出现、锁释放）→ 对话里的画布卡片打开画布', async () => {
  test.setTimeout(420_000);
  const redis = process.env.SPARK_E2E_REDIS_CONTAINER;
  if (redis) execFileSync('docker', ['exec', redis, 'redis-cli', 'DEL', `auth:code:limit:${EMAIL}`]);

  const dirs = tempDirs('canvas');
  const { app, page } = await launch(dirs, { skipLogin: false, env: { SPARK_WEB_API_URL: webApi } });
  try {
    await signIn(page);
    await saveGoogleKey(page);

    // 1) 侧栏「画布」→ 列表 → 新建 → 画布视图（空画布 + 右侧对话栏的第一条消息输入框）
    await page.getByRole('button', { name: '画布', exact: true }).click();
    await expect(page.getByTestId('canvas-list-view')).toBeVisible();
    await page.getByRole('button', { name: '新建画布' }).click();
    const view = page.getByTestId('canvas-view');
    await expect(view).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('.react-flow')).toBeVisible();
    await expect(view.locator('.react-flow__node')).toHaveCount(0);
    await expect(page.getByTestId('canvas-first-message')).toBeVisible();

    // 2) 改名：点标题 → 输入 → 回车
    const title = `桌面画布 ${Date.now()}`;
    await view.getByRole('button', { name: '未命名画布' }).click();
    await view.getByLabel('重命名画布').fill(title);
    await view.getByLabel('重命名画布').press('Enter');
    await expect(view.getByRole('button', { name: title })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(screens, 'canvas-1-empty.png') });

    // 3) 右侧对话栏发第一条消息：新建对话、绑定画布、开跑；本机 agent 用画布工具建节点与连线
    const first = page.getByTestId('canvas-first-message');
    await first
      .getByRole('textbox')
      .fill(
        '在当前画布上用 add_nodes 一次新建两个 image_gen 节点：标题分别是「镜头一」「镜头二」，提示词随便写一句英文；然后用 connect_nodes 把「镜头一」连到「镜头二」。只建节点和连线，绝对不要触发生成，也不要问我。',
      );
    await first.getByRole('textbox').press('Enter');
    const panel = page.getByTestId('canvas-chat-panel');
    await expect(panel.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 30_000 });
    // 跑的过程中画布实时出现节点（agent-host 转发的 canvas_patch）
    await expect(view.locator('.react-flow__node')).toHaveCount(2, { timeout: 150_000 });
    const approvals = await waitTurn(page, { approve: false });
    expect(approvals, 'agent 不应发起任何需要审批的操作（生成 / 删除）').toBe(0);
    await expect(page.getByTestId('approval-panel')).toHaveCount(0);
    await expect(view.locator('.react-flow__edge')).toHaveCount(1, { timeout: 30_000 });
    // agent 操作期间画布按新节点自动聚焦：两张卡都在视野里（不需要用户自己去找）
    await expect(view.locator('.react-flow__node').filter({ hasText: '镜头一' })).toBeInViewport();
    await expect(view.locator('.react-flow__node').filter({ hasText: '镜头二' })).toBeInViewport();
    // 本轮结束释放运行锁：顶栏不再显示「agent 正在编辑」
    await expect(view.getByTestId('canvas-lock-status')).toHaveCount(0, { timeout: 20_000 });
    await page.screenshot({ path: join(screens, 'canvas-2-agent-built.png') });

    // 3b) 停在审批上时运行锁不放（与 Web 画布 agent 等审批时画布仍算忙一致）：先改一次（拿到锁），
    // 再删节点（询问档位要确认）→ 等审批期间顶栏一直显示「agent 正在编辑」→ 拒绝后跑完、锁释放、节点还在
    const input = panel.getByLabel('消息');
    await input.fill(
      '分两步做，不要并行：第一步只调用 update_node，把「镜头一」的标题改成「镜头一A」；拿到结果之后，第二步再调用 delete_node 删除「镜头二」。不要问我，直接调用。',
    );
    await input.press('Enter');
    const approval = page.getByTestId('approval-panel');
    await expect(approval).toBeVisible({ timeout: 120_000 });
    await expect(view.locator('.react-flow__node').filter({ hasText: '镜头一A' })).toBeVisible({ timeout: 20_000 });
    await expect(view.getByTestId('canvas-lock-status')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(screens, 'canvas-2b-approval-locked.png') });
    await approval.getByRole('button', { name: '拒绝', exact: true }).click();
    expect(await waitTurn(page, { approve: false })).toBe(0);
    await expect(view.getByTestId('canvas-lock-status')).toHaveCount(0, { timeout: 20_000 });
    await expect(view.locator('.react-flow__node')).toHaveCount(2);

    // 4) 返回对话：右侧对话栏的那个对话出现在侧栏，带着本轮的工具调用
    await view.getByRole('button', { name: '返回对话' }).click();
    await expect(page.locator('main[data-view^="chat:"]')).toBeVisible();
    await expect(page.getByTestId('timeline')).toContainText('镜头一');

    // 5) 普通对话里让 agent 新建画布：画布在对话右侧的侧栏里实时打开（不跳走、不再带一个对话栏），
    // 对话里出现画布卡片；关掉侧栏后点卡片再打开；「展开全部」盖住对话区，左侧会话栏还在
    await newChat(page);
    const cardTitle = `卡片画布 ${Date.now()}`;
    await sendAndWait(page, `调用 create_canvas 新建一块标题为「${cardTitle}」的画布，然后直接结束，不要做别的，也不要问我。`, {
      approve: false,
    });
    const side = page.getByTestId('chat-side-panel');
    const sideCanvas = side.getByTestId('canvas-view');
    await expect(sideCanvas.getByRole('button', { name: cardTitle })).toBeVisible({ timeout: 20_000 });
    await expect(side.getByTestId('canvas-chat-panel')).toHaveCount(0);
    await expect(page.locator('main[data-view^="chat:"]')).toBeVisible();
    await expect(page.getByLabel('消息')).toBeInViewport();
    const card = page.getByTestId('canvas-card');
    await expect(card).toContainText(cardTitle);
    await page.screenshot({ path: join(screens, 'canvas-3-side-panel.png') });
    // 关闭侧栏是收起：画布的标签还留着（没有卸载），点卡片就是切回这个标签
    await side.getByRole('button', { name: '关闭侧栏' }).click();
    await expect(side).toBeHidden();
    await card.getByRole('button', { name: '打开画布' }).click();
    await expect(side.getByRole('tab')).toHaveCount(1);
    await expect(sideCanvas.getByRole('button', { name: cardTitle })).toBeVisible({ timeout: 15_000 });
    await side.getByRole('button', { name: '展开全部' }).click();
    await expect(side).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByRole('button', { name: '新建对话' })).toBeInViewport();
    await page.screenshot({ path: join(screens, 'canvas-3b-side-panel-expanded.png') });

    // 展开全部时 agent 发来审批：侧栏自动收回停靠，对话里的审批面板露出来（不然盖在下面，agent 一直等）
    await side.getByRole('button', { name: '收起为侧栏' }).click();
    const chatInput = page.getByLabel('消息');
    await chatInput.fill('在当前画布上调用 add_node 建一个 image_gen 节点（标题「待清空」），拿到结果后再调用 clear_canvas 清空画布。不要问我，直接调用。');
    await chatInput.press('Enter');
    await expect(page.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 20_000 });
    await side.getByRole('button', { name: '展开全部' }).click();
    await expect(side).toHaveAttribute('data-expanded', 'true');
    const approvalAgain = page.getByTestId('approval-panel');
    await expect(approvalAgain).toBeVisible({ timeout: 120_000 });
    await expect(side).toHaveAttribute('data-expanded', 'false');
    await expect(approvalAgain).toBeInViewport();
    await approvalAgain.getByRole('button', { name: '拒绝', exact: true }).click();
    expect(await waitTurn(page, { approve: false })).toBe(0);
    await expect(sideCanvas.locator('.react-flow__node').filter({ hasText: '待清空' })).toBeVisible();
    await side.getByRole('button', { name: '关闭侧栏' }).click();

    // 6) 列表里有这两块画布（与网页端同一批）
    await page.getByRole('button', { name: '画布', exact: true }).click();
    const items = page.getByTestId('canvas-list-item');
    await expect(items.filter({ hasText: title })).toBeVisible({ timeout: 15_000 });
    await expect(items.filter({ hasText: cardTitle })).toBeVisible();
    await page.screenshot({ path: join(screens, 'canvas-4-list.png') });
  } finally {
    await app.close();
  }
});
