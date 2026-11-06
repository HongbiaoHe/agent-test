/**
 * 侧栏与会话顶栏（不需要模型）：
 * 新建 → 顶栏标题菜单重命名 → 侧栏「…」置顶（进「已置顶」组）→ ⌘K 搜标题 / 搜消息正文（片段高亮）→
 * 拖右缘调宽（夹在上限、刷新后保持）→ 收起侧栏（顶栏让位、刷新后仍收起）→ 悬停开关临时弹出、在浮层里切会话、移回主区收回 → 删除（确认后消失）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type Page, test } from '@playwright/test';
import { launch, newChat, screens, tempDirs } from './helpers';

const dirs = tempDirs('sidebar');

const nav = (page: Page) => page.getByRole('navigation', { name: '会话' });
const group = (page: Page, label: string) => nav(page).locator('section').filter({ hasText: label });

/** 侧栏列表下方空白处的一小块像素：用来比对浮层与展开态底色一致 */
async function sidebarBlankPixels(page: Page) {
  const h = await page.evaluate(() => window.innerHeight);
  return page.screenshot({ clip: { x: 120, y: h - 90, width: 4, height: 4 } });
}

async function renameCurrent(page: Page, title: string) {
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const input = page.getByLabel('会话标题');
  await input.fill(title);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '会话菜单' })).toContainText(title);
}

test('侧栏：新建 / 重命名 / 置顶分组 / 搜索 / 收起与悬停弹出 / 删除', async () => {
  mkdirSync(dirs.workspace, { recursive: true });
  const { page } = await launch(dirs);

  await newChat(page);
  await renameCurrent(page, 'Alpha 项目');
  await newChat(page);
  await renameCurrent(page, 'Beta 调研');
  await expect(group(page, '今天')).toContainText('Alpha 项目');
  await expect(group(page, '今天')).toContainText('Beta 调研');

  // 超长标题：顶栏标题省略号截断，不盖住右侧 token 徽标；侧栏条目同样截断
  const longTitle = `超长标题 ${'Cinematic night-time stunt film, square 1:1, two shots joined by a hard cut. '.repeat(3)}`.slice(0, 190);
  await newChat(page);
  await renameCurrent(page, longTitle.slice(0, 20));
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByLabel('会话标题').fill(longTitle);
  await page.getByLabel('会话标题').press('Enter');
  const titleBtn = page.getByRole('button', { name: '会话菜单' });
  await expect(titleBtn).toContainText('超长标题');
  const tb = await titleBtn.boundingBox();
  const badge = await page.getByRole('button', { name: /tokens$/ }).boundingBox();
  if (!tb || !badge) throw new Error('顶栏元素不可见');
  expect(tb.x + tb.width).toBeLessThanOrEqual(badge.x);
  expect(await titleBtn.locator('h1').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: join(screens, '59-long-title.png') });
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(nav(page)).not.toContainText('超长标题');

  // 置顶：悬停条目出「…」菜单
  const alpha = nav(page).locator('div.group').filter({ hasText: 'Alpha 项目' });
  await alpha.hover();
  await alpha.getByRole('button', { name: '会话操作' }).click();
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(group(page, '已置顶')).toContainText('Alpha 项目');
  await expect(group(page, '今天')).not.toContainText('Alpha 项目');
  // 分组可折叠
  await group(page, '今天').getByRole('button', { name: '今天' }).click();
  await expect(nav(page)).not.toContainText('Beta 调研');
  await group(page, '今天').getByRole('button', { name: '今天' }).click();
  await expect(nav(page)).toContainText('Beta 调研');
  await page.screenshot({ path: join(screens, '60-sidebar-groups.png') });

  // 展开时开关在侧栏顶部行的右端（与侧栏右边缘留 8px），与顶部行中线对齐
  const asideBox = await page.locator('aside').first().boundingBox();
  const expandedToggle = await page.getByRole('button', { name: '收起侧栏' }).boundingBox();
  if (!asideBox || !expandedToggle) throw new Error('侧栏或开关不可见');
  expect(Math.abs(asideBox.x + asideBox.width - (expandedToggle.x + expandedToggle.width) - 8)).toBeLessThan(2);
  expect(Math.abs(expandedToggle.y + expandedToggle.height / 2 - 24)).toBeLessThan(1);

  // 搜索正文：直接往库里给 Beta 写一条消息（不跑模型）
  const db = new DatabaseSync(join(dirs.userData, 'spark.db'));
  const beta = db.prepare("SELECT id FROM conversation WHERE title = 'Beta 调研'").get();
  db.prepare('INSERT INTO message (id, conversation_id, seq, role, type, content, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)').run(
    randomUUID(),
    String(beta?.id),
    'user',
    'message',
    JSON.stringify({ text: '帮我调研一下 Unicorn 估值的口径' }),
    Date.now(),
  );
  db.close();

  // ⌘K 打开搜索：空输入列出最近会话；搜正文命中并高亮；回车打开
  await page.keyboard.press('Meta+k');
  const search = page.getByTestId('search-dialog');
  await expect(search.getByRole('option')).toHaveCount(2);
  await search.getByLabel('搜索会话').fill('unicorn');
  await expect(search.getByRole('option')).toHaveCount(1);
  await expect(search.getByRole('option')).toContainText('Beta 调研');
  await expect(search.locator('mark')).toHaveText('Unicorn');
  await page.screenshot({ path: join(screens, '61-search-content.png') });
  // 输入后立刻回车：结果还没对上新输入，不应打开旧结果（Beta）
  await search.getByLabel('搜索会话').fill('alpha');
  await search.getByLabel('搜索会话').press('Enter');
  await expect(search).toBeVisible();
  await expect(search.getByRole('option')).toHaveCount(1);
  await expect(search.getByRole('option')).toContainText('Alpha 项目');
  await search.getByLabel('搜索会话').press('Enter');
  await expect(search).toBeHidden();
  await expect(page.getByRole('button', { name: '会话菜单' })).toContainText('Alpha 项目');
  // 侧栏「搜索」按钮也能打开
  await page.getByRole('button', { name: /搜索/ }).first().click();
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');

  // 顶栏标题菜单：置顶状态同步（Alpha 已置顶 → 显示「取消置顶」）
  await page.getByRole('button', { name: '会话菜单' }).click();
  await expect(page.getByRole('menuitem', { name: '取消置顶' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '在访达中打开工作区' })).toBeVisible();
  await page.screenshot({ path: join(screens, '62-title-menu.png') });
  await page.keyboard.press('Escape');

  // 拖右缘调宽：跟手、开关随右缘移动；超出上限被夹住（刷新后保持：见下面收起刷新后浮层仍是 400 宽）
  const sidebarAside = page.locator('aside').filter({ has: nav(page) });
  const dragSidebarEdge = async (toX: number) => {
    const box = await page.getByRole('separator', { name: '调整侧栏宽度' }).boundingBox();
    if (!box) throw new Error('调宽把手不可见');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(toX, y, { steps: 5 });
    await page.mouse.up();
  };
  await dragSidebarEdge(320);
  expect((await sidebarAside.boundingBox())?.width).toBe(320);
  // 开关贴侧栏顶部行右端：320 - 8 - 28
  expect((await page.getByRole('button', { name: '收起侧栏' }).boundingBox())?.x).toBe(284);
  await page.screenshot({ path: join(screens, '62b-resized.png') });
  await dragSidebarEdge(1000);
  expect((await sidebarAside.boundingBox())?.width).toBe(400);

  const expandedPixels = await sidebarBlankPixels(page);

  // 收起侧栏：侧栏消失，顶栏标题让出红绿灯与开关的位置；刷新后仍是收起
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(nav(page)).toBeHidden();
  // 开关从侧栏右端滑回红绿灯旁（left-20 = 80px，有 200ms 过渡）：等它停稳再量
  await expect
    .poll(async () => (await page.getByRole('button', { name: '展开侧栏' }).boundingBox())?.x)
    .toBe(80);
  const titleBox = await page.getByRole('button', { name: '会话菜单' }).boundingBox();
  const toggleBox = await page.getByRole('button', { name: '展开侧栏' }).boundingBox();
  if (!titleBox || !toggleBox) throw new Error('顶栏元素不可见');
  expect(titleBox.x).toBeGreaterThan(toggleBox.x + toggleBox.width);
  expect(Math.abs(titleBox.y + titleBox.height / 2 - (toggleBox.y + toggleBox.height / 2))).toBeLessThan(2);
  await page.screenshot({ path: join(screens, '63-collapsed.png') });
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible({ timeout: 20_000 });
  await expect(nav(page)).toBeHidden();

  // 悬停开关：侧栏浮层弹出；在浮层里切会话后浮层收回
  await page.getByRole('button', { name: '展开侧栏' }).hover();
  const peek = page.getByTestId('sidebar-peek');
  await expect(peek).toBeVisible();
  // 浮层：与窗口等高、无圆角、底色与展开态一致
  const peekBox = await peek.locator('aside').boundingBox();
  const innerHeight = await page.evaluate(() => window.innerHeight);
  expect(peekBox?.y).toBe(0);
  expect(peekBox?.height).toBe(innerHeight);
  expect(peekBox?.width).toBe(400); // 浮层沿用调过的宽度，且刷新后仍在
  expect(await peek.locator('aside').evaluate((el) => getComputedStyle(el).borderTopRightRadius)).toBe('0px');
  expect((await sidebarBlankPixels(page)).equals(expandedPixels)).toBe(true);
  await page.screenshot({ path: join(screens, '64-peek.png') });
  await peek.getByRole('button', { name: 'Beta 调研' }).click();
  await expect(peek).toBeHidden();
  await expect(page.getByRole('button', { name: '会话菜单' })).toContainText('Beta 调研');
  // 再弹出，鼠标移到主区 → 收回
  await page.getByRole('button', { name: '展开侧栏' }).hover();
  await expect(peek).toBeVisible();
  await page.mouse.move(900, 500, { steps: 5 });
  await expect(peek).toBeHidden();

  // 展开回来，深色主题截图
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await expect(nav(page)).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.waitForTimeout(500); // 等配色过渡动画走完再截图
  await page.screenshot({ path: join(screens, '65-sidebar-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // 删除：确认后从侧栏消失，回到首页
  await page.getByRole('button', { name: '会话菜单' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(nav(page)).not.toContainText('Beta 调研');
  await expect(page.locator('main[data-view]')).toHaveAttribute('data-view', 'home');
});
