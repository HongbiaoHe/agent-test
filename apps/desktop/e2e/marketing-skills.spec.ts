/**
 * 内置营销技能（移植自 BuzzVideo Marketing Agent：strategist / copywriter / designer / video-producer / audio-producer）：
 * - 设置 → 技能：5 个都作为内置技能列出；
 * - 真实模型：/strategist 会读路由与子技能文件再出创意方向；/video-producer 先读 video-script-framework，
 *   出脚本后停在「用户审核」这一步（不调用生成工具）。
 */
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { closeSettings, launch, newChat, openSettings, saveGoogleKey, screens, sendAndWait, tempDirs } from './helpers';

const MARKETING = ['strategist', 'copywriter', 'designer', 'video-producer', 'audio-producer'];

test('内置营销技能：设置里列出；/strategist、/video-producer 按技能文件工作，视频停在脚本审核', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch(tempDirs('marketing-skills'));
  await saveGoogleKey(page);

  await openSettings(page, '技能');
  for (const name of MARKETING) await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.screenshot({ path: join(screens, 'marketing-1-skills.png') });
  await closeSettings(page);

  const timeline = page.getByTestId('timeline');
  /** 展开这一轮的步骤（「用时 … · N 步」），工具调用会列出 read_file 的路径 */
  const expandSteps = async () => {
    await timeline.getByText(/用时 .* 步/).last().click();
  };

  // 创意方向：读路由 + big-idea 子技能，按它的模板（Primary driver / Central insight）出 3 个方向
  await newChat(page);
  await sendAndWait(page, '/strategist 给一家主打手冲的精品咖啡馆品牌「山雾」想 3 个创意方向（Big Idea），每个方向两三句话即可。');
  await expandSteps();
  await expect(timeline).toContainText('skills/strategist/SKILL.md');
  await expect(timeline).toContainText('skills/strategist/big-idea-concept-pitching.md');
  await expect(timeline).toContainText('Primary driver');
  await page.screenshot({ path: join(screens, 'marketing-2-strategist.png') });

  // 视频脚本：先读 video-script-framework，按区块（PATTERN_INTERRUPT …）出脚本，停在审核（请用户确认），不生成
  await newChat(page);
  await sendAndWait(page, '/video-producer 帮我写一条 15 秒的 TikTok 竖版广告脚本，推广「山雾」咖啡的冷萃新品，面向 20-30 岁上班族。');
  await expandSteps();
  await expect(timeline).toContainText('skills/video-producer/video-script-framework.md');
  await expect(timeline).toContainText('PATTERN_INTERRUPT');
  await expect(timeline).toContainText('确认');
  await expect(timeline).not.toContainText('generate_video');
  await page.screenshot({ path: join(screens, 'marketing-3-video-producer.png') });
  await app.close();
});
