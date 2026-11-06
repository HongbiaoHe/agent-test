import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, expect, type Page } from '@playwright/test';

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

export type SettingsSection = '账号' | '外观' | '模型' | '工作区' | '技能' | '连接器';

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

export async function saveGoogleKey(page: Page): Promise<void> {
  await openSettings(page, '模型');
  await page.getByLabel('Google Gemini API Key').fill(apiKey);
  await page.getByRole('button', { name: '保存' }).first().click();
  await expect(page.getByText('已配置').first()).toBeVisible({ timeout: 20_000 });
  await closeSettings(page);
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
  const send = page.getByRole('button', { name: '发送', exact: true });
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
