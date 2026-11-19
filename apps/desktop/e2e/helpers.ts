import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page } from '@playwright/test';

export const apiKey = process.env.SPARK_E2E_GOOGLE_API_KEY ?? '';
export const screens = join(__dirname, '..', 'test-results', 'screens');
mkdirSync(screens, { recursive: true });

/** 每个 spec 一套临时目录：userData（库、设置、密钥）+ 工作区 */
export function tempDirs(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `spark-e2e-${prefix}-`));
  return { root, userData: join(root, 'user-data'), workspace: join(root, 'workspace') };
}

export async function launch(
  dirs: { userData: string; workspace: string },
  opts: { skipLogin?: boolean; env?: Record<string, string> } = {},
): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  // SPARK_E2E_EXECUTABLE：对打包产物（release/…/Spark.app/Contents/MacOS/Spark）跑同一套用例
  const executablePath = process.env.SPARK_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [join(__dirname, '..')] }),
    env: {
      ...process.env,
      SPARK_USER_DATA_DIR: dirs.userData,
      SPARK_DEFAULT_WORKSPACE: dirs.workspace,
      // 用例按简体中文文案定位元素：固定「系统语言」，不受跑测试的机器影响（个别用例经 opts.env 覆盖）
      SPARK_SYSTEM_LANGUAGE: 'zh-CN',
      ...opts.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  if (opts.skipLogin ?? true) await skipLoginIfShown(page);
  return { app, page };
}

/** 启动时的登录页（没登录、没跳过过）：点「先跳过」进主界面；已跳过 / 已登录时直接是主界面 */
export async function skipLoginIfShown(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: '先跳过，不登录使用' });
  const main = page.getByRole('button', { name: '新建对话' });
  await expect(skip.or(main)).toBeVisible({ timeout: 20_000 });
  if (await skip.isVisible()) await skip.click();
  await expect(main).toBeVisible();
}

export type SettingsSection = '账号' | '外观' | '模型' | '工作区' | '技能' | '连接器' | '模式';

/** 打开设置弹窗并切到某个分类（弹窗已开着就直接切） */
export async function openSettings(page: Page, section: SettingsSection): Promise<void> {
  const nav = page.getByRole('navigation', { name: '设置分类' });
  if (!(await nav.isVisible())) await page.getByRole('button', { name: '设置', exact: true }).click();
  await nav.getByRole('button', { name: section, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: section, exact: true })).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeHidden();
}

/**
 * 原生文件选择框无法点击：在 main 进程里替换「选文件夹 / 选文件」两个 IPC handler，直接返回给定路径。
 * （给 dialog.showOpenDialog 赋值不生效：electron 模块上的属性不可写，赋值被静默忽略）
 */
export async function stubOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ ipcMain }, filePaths) => {
    ipcMain.removeHandler('desktop:pickFolder');
    ipcMain.handle('desktop:pickFolder', () => filePaths[0] ?? null);
    ipcMain.removeHandler('desktop:pickFiles');
    ipcMain.handle('desktop:pickFiles', () => filePaths);
  }, paths);
}

/** e2e 用的 Gemini 模型（saveGoogleKey 启用它并设为账号默认模型） */
export const E2E_MODEL = 'gemini-3.8-flash';

/** 连接详情侧拉（设置 → 模型里点开一个连接 / 新建连接后自动打开） */
export function connectionSheet(page: Page): Locator {
  return page.getByTestId('llm-connection-sheet');
}

/**
 * 设置 → 模型 → 添加连接：选预设（填好协议 / Base URL / 名称）、可选填 Key、保存。
 * 保存后会自动拉取一次模型列表（真实网络，最多 60 秒），结束后弹窗关闭、自动打开该连接的详情侧拉。
 */
export async function addConnection(
  page: Page,
  opts: { preset: string; apiKey?: string; baseUrl?: string },
): Promise<Locator> {
  await openSettings(page, '模型');
  await page.getByRole('button', { name: '添加连接' }).click();
  const dialog = page.getByRole('dialog', { name: '添加 API 连接' });
  await dialog.getByRole('combobox', { name: '服务商' }).click();
  await page.getByRole('option', { name: opts.preset, exact: true }).click();
  if (opts.baseUrl) await dialog.getByLabel('Base URL').fill(opts.baseUrl);
  if (opts.apiKey) await dialog.getByLabel(/^API Key/).fill(opts.apiKey);
  await dialog.getByRole('button', { name: '保存并拉取模型' }).click();
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  const sheet = connectionSheet(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/** 在连接详情里搜索模型并勾选启用（已启用就不动） */
export async function enableModel(sheet: Locator, modelId: string): Promise<void> {
  await sheet.getByRole('textbox', { name: '搜索模型' }).fill(modelId);
  const checkbox = sheet.getByRole('checkbox', { name: `启用 ${modelId}`, exact: true });
  await expect(checkbox).toBeVisible({ timeout: 20_000 });
  if (!(await checkbox.isChecked())) await checkbox.click();
  await expect(checkbox).toBeChecked();
}

/** 关掉连接详情侧拉（设置弹窗还开着） */
export async function closeConnectionSheet(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(connectionSheet(page)).toBeHidden();
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
}

/** 设置 → 模型：把账号默认模型设成某个已启用的模型 */
export async function setDefaultModel(page: Page, modelId: string): Promise<void> {
  await openSettings(page, '模型');
  const combo = page.getByRole('dialog').getByRole('combobox', { name: '默认模型' });
  await combo.click();
  await page.getByRole('option', { name: modelId, exact: true }).click();
  await expect(combo).toContainText(modelId);
}

/**
 * 配好真实模型：添加 Google Gemini 连接（SPARK_E2E_GOOGLE_API_KEY）→ 等自动拉取模型列表 → 启用 E2E_MODEL →
 * 设为默认模型 → 关设置。幂等：已有 Gemini 连接时只确保该模型已启用且是默认模型。
 */
export async function saveGoogleKey(page: Page): Promise<void> {
  await openSettings(page, '模型');
  const cards = page.getByTestId('llm-connection-card');
  // 等列表加载完（有连接 / 空状态），免得把「还在加载」当成没有连接、重复添加
  await expect(cards.first().or(page.getByText('还没有 API 连接'))).toBeVisible({ timeout: 20_000 });
  const gemini = cards.filter({ hasText: 'Google Gemini' });
  let sheet: Locator;
  if ((await gemini.count()) > 0) {
    await gemini.first().click();
    sheet = connectionSheet(page);
    await expect(sheet).toBeVisible();
  } else {
    sheet = await addConnection(page, { preset: 'Google Gemini', apiKey });
  }
  await enableModel(sheet, E2E_MODEL);
  await closeConnectionSheet(page);
  await setDefaultModel(page, E2E_MODEL);
  await closeSettings(page);
}

/**
 * 不联网也能用的模型：添加 Ollama 连接（本地、不要 Key；本机没装 Ollama，自动拉取会失败并内联报错），
 * 再手动添加一个模型 id（手动添加默认启用）。结束时设置弹窗停在「模型」、侧拉已关。
 */
export async function addLocalModel(page: Page, modelId: string): Promise<void> {
  const sheet = await addConnection(page, { preset: 'Ollama' });
  await expect(sheet.getByTestId('refresh-error')).toBeVisible();
  await sheet.getByRole('textbox', { name: '手动添加模型' }).fill(modelId);
  await sheet.getByRole('button', { name: '添加', exact: true }).click();
  await expect(sheet.getByRole('checkbox', { name: `启用 ${modelId}`, exact: true })).toBeChecked();
  await closeConnectionSheet(page);
}

/** 发一条消息并等这一轮跑完（发送按钮重新出现）；途中的审批一律批准（approve=false 时遇到审批即返回） */
export async function sendAndWait(page: Page, text: string, opts: { approve?: boolean } = {}): Promise<number> {
  const input = page.getByLabel('消息');
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 20_000 });
  return waitTurn(page, opts);
}

/** 等这一轮结束：遇到审批面板就点 Approve（返回批准了几次） */
export async function waitTurn(page: Page, { approve = true }: { approve?: boolean } = {}): Promise<number> {
  // includeHidden：agent 调 preview_page 后网页预览以模态弹窗自动打开，弹窗把聊天区标成 aria-hidden，
  // 默认的 getByRole 就再也找不到「发送」——这一轮其实已结束，却会一直等到超时。按钮仍在 DOM 里且可见（只是被盖住）。
  const send = page.getByRole('button', { name: '发送', exact: true, includeHidden: true });
  const panel = page.getByTestId('approval-panel');
  let approved = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await send.isVisible()) return approved;
    if (await panel.isVisible()) {
      if (!approve) return approved;
      await panel.getByRole('button', { name: '批准', exact: true }).click();
      approved++;
      await expect(panel).toBeHidden({ timeout: 30_000 });
      continue;
    }
    await page.waitForTimeout(300);
  }
  // 现场：截图 + 输入区按钮，区分「界面没收尾」与「agent 还在跑」
  await page.screenshot({ path: join(screens, `timeout-${Date.now()}.png`) });
  const buttons = await page.getByRole('button').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()).filter(Boolean),
  );
  const view = await page.locator('main[data-view]').getAttribute('data-view').catch(() => null);
  throw new Error(`等待本轮结束超时；当前视图：${view ?? '无'}；当前按钮：${buttons.join(' | ')}`);
}

/** 侧栏「+」新建对话，并等新会话的空状态出现（否则可能把消息填进上一个会话的输入框） */
export async function newChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByText('开始对话')).toBeVisible();
}

/** 输入框工具条上切换本会话的权限档位（只读 / 询问 / 自动） */
export async function setPermission(page: Page, label: '只读' | '询问' | '自动'): Promise<void> {
  await page.getByRole('button', { name: /^权限：/ }).click();
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByRole('button', { name: `权限：${label}` })).toBeVisible();
}
