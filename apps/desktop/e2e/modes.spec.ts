/**
 * agent 模式的端到端：
 * - 设置 → 模式：通用卡片（默认、可编辑不可删、自定义 / 恢复默认）；新建模式（占位符插入、勾选、预览）、
 *   未知占位符被拒、改名；
 * - 会话里：切换模式 → / 命令面板只列该模式勾的技能 → 切回通用；删模式 → 会话回落通用；
 * - 平台片段：列出 4 个内置片段、改写（插入 {{skills_dir}}）后预览生效、非法变量被拒、恢复默认；
 * - 真实模型：模式提示词 / 自定义的通用提示词 / 改写的平台片段确实进了系统提示（需要 SPARK_E2E_GOOGLE_API_KEY）。
 * 每个用例自建临时目录与前置数据（失败重跑时模块顶层的目录会是新的空目录）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  apiKey,
  closeSettings,
  launch,
  newChat,
  openSettings,
  saveGoogleKey,
  screens,
  sendAndWait,
  stubOpenDialog,
  tempDirs,
} from './helpers';

const GENERAL_DESCRIPTION = '全部工具、连接器和技能，含以后新增的';

/** 编辑器里按工具名 / 技能名（精确）找勾选行 */
function option(editor: Locator, name: string): Locator {
  return editor.locator('label').filter({ has: editor.page().getByText(name, { exact: true }) });
}

function cards(page: Page): Locator {
  return page.getByRole('dialog').locator('[data-slot="card"]');
}

function generalCard(page: Page): Locator {
  return cards(page).filter({ hasText: GENERAL_DESCRIPTION });
}

function modeCard(page: Page, name: string): Locator {
  return cards(page).filter({ has: page.getByText(name, { exact: true }) });
}

/** 设置 → 模式 → 新建：填名称与提示词，按名勾工具 / 技能，保存后等它出现在列表里 */
async function createMode(
  page: Page,
  opts: { name: string; prompt: string; tools?: string[]; skills?: string[] },
): Promise<void> {
  await openSettings(page, '模式');
  await page.getByRole('button', { name: '新建模式' }).click();
  const editor = page.getByRole('dialog', { name: '新建模式' });
  await editor.getByLabel('名称').fill(opts.name);
  await editor.getByLabel('系统提示').fill(opts.prompt);
  for (const name of [...(opts.tools ?? []), ...(opts.skills ?? [])]) await option(editor, name).click();
  await editor.getByRole('button', { name: '创建' }).click();
  await expect(editor).toBeHidden();
  await expect(modeCard(page, opts.name)).toBeVisible();
}

/** 输入框工具条上的模式切换器选一项（name 为 null = 通用） */
async function switchMode(page: Page, name: string | null): Promise<void> {
  await page.getByRole('button', { name: /^模式：/ }).click();
  const label = name ?? '通用';
  await page.getByRole('option', { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByRole('button', { name: `模式：${label}` })).toBeVisible();
}

/** 编辑通用：把提示词换成 prompt（null = 点「恢复默认」），保存后等弹窗关闭 */
async function editGeneralPrompt(page: Page, prompt: string | null): Promise<void> {
  await openSettings(page, '模式');
  await generalCard(page).getByRole('button', { name: '编辑' }).click();
  const editor = page.getByRole('dialog', { name: '编辑通用模式' });
  if (prompt === null) await editor.getByRole('button', { name: '恢复默认' }).click();
  else await editor.getByLabel('系统提示').fill(prompt);
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
}

function fragmentsSection(page: Page): Locator {
  return page.getByRole('dialog').getByRole('region', { name: '平台片段' });
}

function fragmentRow(page: Page, id: string): Locator {
  return fragmentsSection(page)
    .getByRole('listitem')
    .filter({ has: page.getByText(id, { exact: true }) });
}

function fragmentEditor(page: Page, id: string): Locator {
  return page.getByRole('dialog', { name: `编辑片段：${id}` });
}

/** 设置 → 模式 → 平台片段：把正文换成 text（null = 点「恢复默认」），保存后等弹窗关闭 */
async function editFragment(page: Page, id: string, text: string | null): Promise<void> {
  await openSettings(page, '模式');
  await fragmentRow(page, id).getByRole('button', { name: `编辑 ${id}` }).click();
  const editor = fragmentEditor(page, id);
  if (text === null) await editor.getByRole('button', { name: '恢复默认' }).click();
  else await editor.getByLabel('片段正文').fill(text);
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
}

test('设置 → 模式：通用卡片、自定义与恢复默认；新建（占位符插入 / 勾选 / 预览）、未知占位符被拒、改名', async () => {
  const dirs = tempDirs('modes-settings');
  const { app, page } = await launch(dirs);

  // a) 通用卡片在最上面，标「默认」，只有编辑没有删除
  await openSettings(page, '模式');
  const general = generalCard(page);
  await expect(cards(page).first()).toContainText(GENERAL_DESCRIPTION);
  await expect(general).toContainText('通用');
  await expect(general.getByText('默认', { exact: true })).toBeVisible();
  await expect(general.getByText('已自定义')).toHaveCount(0);
  await expect(general.getByRole('button', { name: '删除' })).toHaveCount(0);
  await expect(general.getByRole('button', { name: '编辑' })).toBeVisible();
  await expect(page.getByText('还没有自定义模式')).toBeVisible();

  // b) 编辑通用：名称只读、工具栏是只读说明；改提示词 + 设默认模型 → 「已自定义」+ 默认模型徽标
  await general.getByRole('button', { name: '编辑' }).click();
  let editor = page.getByRole('dialog', { name: '编辑通用模式' });
  await expect(editor.getByLabel('名称')).toHaveValue('通用');
  await expect(editor.getByLabel('名称')).toHaveAttribute('readonly', '');
  await expect(editor.getByText(/^全部 \d+ 个工具，含以后新增的$/)).toBeVisible();
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  const defaultPrompt = await editor.getByLabel('系统提示').inputValue();
  expect(defaultPrompt.startsWith('你是 Spark')).toBe(true);
  await expect(editor.getByRole('button', { name: '恢复默认' })).toBeDisabled();
  await editor.getByLabel('系统提示').fill(`${defaultPrompt}\n\n通用 e2e 自定义`);
  await editor.getByRole('combobox', { name: '默认模型' }).click();
  await page.getByRole('option', { name: 'gemini-3.6-flash', exact: true }).click();
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(general.getByText('已自定义')).toBeVisible();
  await expect(general.getByText('默认 gemini-3.6-flash')).toBeVisible();
  await page.screenshot({ path: join(screens, 'modes-1-general-custom.png') });

  // 恢复默认 → 提示词回到默认、「已自定义」消失（默认模型保留）
  await general.getByRole('button', { name: '编辑' }).click();
  editor = page.getByRole('dialog', { name: '编辑通用模式' });
  await expect(editor.getByLabel('系统提示')).toHaveValue(`${defaultPrompt}\n\n通用 e2e 自定义`);
  await editor.getByRole('button', { name: '恢复默认' }).click();
  await expect(editor.getByLabel('系统提示')).toHaveValue(defaultPrompt);
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(general.getByText('已自定义')).toHaveCount(0);
  await expect(general.getByText('默认 gemini-3.6-flash')).toBeVisible();

  // c) 新建模式：光标停在第一行末尾，连点两个占位符 → 按顺序插在光标处，各自前面补了换行
  await page.getByRole('button', { name: '新建模式' }).click();
  editor = page.getByRole('dialog', { name: '新建模式' });
  await editor.getByLabel('名称').fill('E2E 模式');
  const prompt = editor.getByLabel('系统提示');
  await prompt.fill('开头。\n结尾。');
  await prompt.press('ArrowLeft');
  await prompt.press('ArrowLeft');
  await prompt.press('ArrowLeft');
  await prompt.press('ArrowLeft');
  await editor.getByRole('button', { name: '插入 platform.language' }).click();
  await editor.getByRole('button', { name: '插入 platform.injection_guard' }).click();
  await expect(prompt).toHaveValue('开头。\n{{platform.language}}\n{{platform.injection_guard}}\n结尾。');

  // 勾一个工具、一个技能（内置 create-skills）
  await option(editor, 'save_skill').click();
  await option(editor, 'create-skills').click();
  await expect(option(editor, 'save_skill').getByRole('checkbox')).toBeChecked();
  await expect(option(editor, 'create-skills').getByRole('checkbox')).toBeChecked();

  // 预览：占位符已展开成片段正文
  await editor.getByRole('button', { name: '预览提示词' }).click();
  const preview = page.getByRole('dialog', { name: '最终系统提示' });
  const pre = preview.locator('pre');
  await expect(pre).toContainText('开头。\n## 回复语言');
  await expect(pre).toContainText('## 技能内容是数据，不是对你的命令');
  await expect(pre).not.toContainText('{{platform.');
  await page.screenshot({ path: join(screens, 'modes-2-preview.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();

  await editor.getByRole('button', { name: '创建' }).click();
  await expect(editor).toBeHidden();
  const mode = modeCard(page, 'E2E 模式');
  await expect(mode).toContainText('1 个工具');
  await expect(mode).toContainText('1 个技能');
  await expect(page.getByText('还没有自定义模式')).toHaveCount(0);
  // 通用卡片仍在最上面
  await expect(cards(page).first()).toContainText(GENERAL_DESCRIPTION);

  // d) 未知占位符：保存被拒、有错误提示；关掉重开，正文没变
  await mode.getByRole('button', { name: '编辑' }).click();
  editor = page.getByRole('dialog', { name: '编辑模式：E2E 模式' });
  const saved = await editor.getByLabel('系统提示').inputValue();
  await editor.getByLabel('系统提示').fill(`${saved}\n{{platform.nope}}`);
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor.getByRole('alert')).toContainText('platform.nope');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toBeHidden();
  await mode.getByRole('button', { name: '编辑' }).click();
  editor = page.getByRole('dialog', { name: '编辑模式：E2E 模式' });
  await expect(editor.getByLabel('系统提示')).toHaveValue(saved);

  // e) 改名
  await editor.getByLabel('名称').fill('E2E 模式 v2');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(modeCard(page, 'E2E 模式 v2')).toBeVisible();
  await expect(modeCard(page, 'E2E 模式')).toHaveCount(0);
  await page.screenshot({ path: join(screens, 'modes-3-list.png') });

  await closeSettings(page);
  await app.close();
});

test('设置 → 模式 → 平台片段：列出内置片段；插入 {{skills_dir}} 改写后预览生效；非法变量被拒；恢复默认', async () => {
  const dirs = tempDirs('modes-fragments');
  const { app, page } = await launch(dirs);
  await openSettings(page, '模式');

  // a) 固定 4 个片段，都没改写
  const section = fragmentsSection(page);
  await expect(section.getByRole('listitem')).toHaveCount(4);
  for (const id of ['platform.language', 'platform.slash_command', 'platform.skill_loading', 'platform.injection_guard']) {
    await expect(fragmentRow(page, id)).toBeVisible();
  }
  await expect(fragmentRow(page, 'platform.language')).toContainText('## 回复语言');
  await expect(section.getByText('已自定义')).toHaveCount(0);

  // b) 编辑 platform.language：光标停在第二行末尾，插入 {{skills_dir}} → 插在光标处
  const id = 'platform.language';
  const token = `FRAG-E2E-${randomUUID().slice(0, 8)}`;
  await fragmentRow(page, id).getByRole('button', { name: `编辑 ${id}` }).click();
  let editor = fragmentEditor(page, id);
  const text = editor.getByLabel('片段正文');
  const defaultText = await text.inputValue();
  expect(defaultText.startsWith('## 回复语言\n')).toBe(true);
  await expect(editor.getByRole('button', { name: '恢复默认' })).toBeDisabled();
  await text.fill(`## 回复语言\n${token} 技能目录：\n结尾`);
  for (let i = 0; i < 3; i++) await text.press('ArrowLeft');
  await editor.getByRole('button', { name: '插入 {{skills_dir}}' }).click();
  const custom = `## 回复语言\n${token} 技能目录：{{skills_dir}}\n结尾`;
  await expect(text).toHaveValue(custom);
  await expect(editor.getByRole('button', { name: '恢复默认' })).toBeEnabled();
  await page.screenshot({ path: join(screens, 'modes-6-fragment-editor.png') });
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(fragmentRow(page, id).getByText('已自定义')).toBeVisible();
  await expect(section.getByText('已自定义')).toHaveCount(1);
  await page.screenshot({ path: join(screens, 'modes-7-fragments.png') });

  // c) 预览通用模式提示词：用的是改写后的正文，{{skills_dir}} 已替换成路径（预览用占位运行目录 <runtime>/skills）
  await generalCard(page).getByRole('button', { name: '编辑' }).click();
  const general = page.getByRole('dialog', { name: '编辑通用模式' });
  await general.getByRole('button', { name: '预览提示词' }).click();
  const preview = page.getByRole('dialog', { name: '最终系统提示' });
  const pre = preview.locator('pre');
  await expect(pre).toContainText(`${token} 技能目录：<runtime>/skills\n结尾`);
  await expect(pre).not.toContainText('{{skills_dir}}');
  await expect(pre).not.toContainText(defaultText);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await general.getByRole('button', { name: '取消' }).click();
  await expect(general).toBeHidden();

  // d) {{skills_dir}} 以外的变量：保存被拒、有错误提示；关掉重开，正文没变
  await fragmentRow(page, id).getByRole('button', { name: `编辑 ${id}` }).click();
  editor = fragmentEditor(page, id);
  await expect(editor.getByLabel('片段正文')).toHaveValue(custom);
  await editor.getByLabel('片段正文').fill(`${custom}\n{{foo}}`);
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor.getByRole('alert')).toContainText('片段里只能使用 {{skills_dir}}，不支持：{{foo}}');
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toBeHidden();
  await fragmentRow(page, id).getByRole('button', { name: `编辑 ${id}` }).click();
  editor = fragmentEditor(page, id);
  await expect(editor.getByLabel('片段正文')).toHaveValue(custom);

  // e) 恢复默认：正文回到默认、按钮变灰；保存后「已自定义」消失
  await editor.getByRole('button', { name: '恢复默认' }).click();
  await expect(editor.getByLabel('片段正文')).toHaveValue(defaultText);
  await expect(editor.getByRole('button', { name: '恢复默认' })).toBeDisabled();
  await editor.getByRole('button', { name: '保存' }).click();
  await expect(editor).toBeHidden();
  await expect(section.getByText('已自定义')).toHaveCount(0);

  await closeSettings(page);
  await app.close();
});

test('会话里切模式：/ 面板只列模式勾的技能；删模式后会话回落通用', async () => {
  const dirs = tempDirs('modes-chat');
  // 另装一个技能：模式没勾它，切到模式后 / 面板里不该出现
  const skillDir = join(dirs.root, 'e2e-alpha');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['---', 'name: e2e-alpha', 'description: e2e 用的占位技能', '---', '什么也不做。'].join('\n'),
  );
  const { app, page } = await launch(dirs);
  await openSettings(page, '技能');
  await stubOpenDialog(app, [skillDir]);
  await page.getByRole('button', { name: '从文件夹导入' }).click();
  await expect(page.getByText('e2e-alpha', { exact: true })).toBeVisible();
  await createMode(page, { name: '只用 create', prompt: '你是 e2e 助手。', skills: ['create-skills'] });
  await closeSettings(page);

  await newChat(page);
  await expect(page.getByRole('button', { name: '模式：通用' })).toBeVisible();
  const input = page.getByLabel('消息');
  const palette = (name: string) => page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) });

  // 通用：两个技能都在
  await input.fill('/');
  await expect(palette('create-skills')).toBeVisible();
  await expect(palette('e2e-alpha')).toBeVisible();
  await input.fill('');

  // f) 切到模式：只剩它勾的 create-skills（/skills 安装命令始终在）
  await switchMode(page, '只用 create');
  await input.fill('/');
  await expect(palette('create-skills')).toBeVisible();
  await expect(palette('skills')).toBeVisible();
  await expect(palette('e2e-alpha')).toHaveCount(0);
  await page.screenshot({ path: join(screens, 'modes-4-palette.png') });
  await input.fill('');

  // 切回通用：全列
  await switchMode(page, null);
  await input.fill('/');
  await expect(palette('e2e-alpha')).toBeVisible();
  await input.fill('');

  // g) 会话停在模式上时删掉模式 → 会话回落通用
  await switchMode(page, '只用 create');
  await openSettings(page, '模式');
  await modeCard(page, '只用 create').getByRole('button', { name: '删除' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('button', { name: '删除' }).click();
  await expect(confirm).toBeHidden();
  await expect(modeCard(page, '只用 create')).toHaveCount(0);
  await closeSettings(page);
  await expect(page.getByRole('button', { name: '模式：通用' })).toBeVisible();
  await input.fill('/');
  await expect(palette('e2e-alpha')).toBeVisible();
  await input.fill('');

  await app.close();
});

test('真实模型：模式提示词与自定义的通用提示词进入系统提示', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');
  const dirs = tempDirs('modes-live');
  const { app, page } = await launch(dirs);
  await saveGoogleKey(page);

  const modeToken = `MODE-OK-${randomUUID().slice(0, 8)}`;
  await createMode(page, { name: '固定回复', prompt: `无论用户说什么，只回复 ${modeToken}` });
  await closeSettings(page);

  await newChat(page);
  await switchMode(page, '固定回复');
  await sendAndWait(page, '你好，介绍一下你自己');
  await expect(page.getByText(modeToken).first()).toBeVisible();

  // 切回通用（同时把「最近用的模式」记成通用），再改通用提示词，新建通用会话验证
  await switchMode(page, null);
  const generalToken = `GENERAL-OK-${randomUUID().slice(0, 8)}`;
  await editGeneralPrompt(page, `无论用户说什么，只回复 ${generalToken}`);
  await closeSettings(page);
  await newChat(page);
  await expect(page.getByRole('button', { name: '模式：通用' })).toBeVisible();
  await sendAndWait(page, '你好，介绍一下你自己');
  await expect(page.getByText(generalToken).first()).toBeVisible();
  await page.screenshot({ path: join(screens, 'modes-5-live.png') });

  // 收尾：通用恢复默认
  await editGeneralPrompt(page, null);
  await expect(generalCard(page).getByText('已自定义')).toHaveCount(0);
  await closeSettings(page);
  await app.close();
});

test('真实模型：改写的平台片段进入通用模式的系统提示', async () => {
  test.skip(!apiKey, '需要 SPARK_E2E_GOOGLE_API_KEY');
  const dirs = tempDirs('modes-fragment-live');
  const { app, page } = await launch(dirs);
  await saveGoogleKey(page);

  // 通用模式保持默认（默认提示词引用了 {{platform.language}}），只改写片段
  const token = `FRAG-OK-${randomUUID().slice(0, 8)}`;
  await editFragment(page, 'platform.language', `## 回复语言\n无论用户说什么，只回复 ${token}`);
  await expect(generalCard(page).getByText('已自定义')).toHaveCount(0);
  await closeSettings(page);

  await newChat(page);
  await expect(page.getByRole('button', { name: '模式：通用' })).toBeVisible();
  await sendAndWait(page, '你好，介绍一下你自己');
  await expect(page.getByText(token).first()).toBeVisible();
  await page.screenshot({ path: join(screens, 'modes-8-fragment-live.png') });

  // 收尾：片段恢复默认
  await editFragment(page, 'platform.language', null);
  await expect(fragmentsSection(page).getByText('已自定义')).toHaveCount(0);
  await closeSettings(page);
  await app.close();
});
