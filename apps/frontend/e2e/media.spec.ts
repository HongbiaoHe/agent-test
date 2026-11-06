import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import type { MediaGeneration } from "@/lib/api";

import { apiOk, loggedInAs, uniqueTag, waitConversationIdle } from "./helpers";
import { COMPOSER_PLACEHOLDER, contentText, toolResults, sendMessage } from "./helpers/chat";
import { conversationTracker, openSandboxPanel } from "./helpers/sandbox";

// 媒体生成：带参考图生图（真实 aigc，每次运行只生 1 张图，会消耗少量额度）→ 媒体卡片出图 →
// sync_media_to_sandbox 同步进沙箱工作区。与 sandbox / background 共用 e2e-web-sandbox 账号的沙箱。
// afterEach 删本条用例建的会话；参考图放系统临时目录，用完删掉。

loggedInAs("e2e-web-sandbox@example.test");

const conversations = conversationTracker();
test.beforeEach(() => conversations.reset());
test.afterEach(async ({ page }) => conversations.cleanup(page));

/** ffmpeg testsrc 生成 720×720 的参考图（aigc 上游要求参考图高 ≥ 300px）。 */
function makeReferencePng(tag: string): string {
  const file = join(tmpdir(), `e2e-web-media-ref-${tag}.png`);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=720x720:rate=1",
    "-frames:v",
    "1",
    file,
  ]);
  return file;
}

test("generate an image from an attached reference, then sync it into the workspace", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const tag = uniqueTag();
  const refFile = makeReferencePng(tag);
  const prompt = `a red apple on a white table, studio light, ${tag}`;
  try {
    const id = await conversations.open(page);

    // 附件：参考图上传完成后发送可用
    await page.locator('input[type="file"]').setInputFiles(refFile);
    await page
      .getByPlaceholder(COMPOSER_PLACEHOLDER)
      .fill(
        `我确认要生成：用 generate_image 生成 1 张图（count 为 1），提示词原样用「${prompt}」，用默认模型，` +
          `把我这条消息的附件图作为参考图（referenceVersionIds 用附件的 versionId）。` +
          `不用再问我，直接调用，只调用这一次，不要调用其它工具。提交后直接结束本轮。`,
      );
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled({ timeout: 60_000 });
    const posted = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/api-backend/conversations/${id}/messages`),
    );
    await send.click();
    expect((await posted).ok()).toBe(true);

    // 媒体卡片出图：图片真正解码出来、状态 Done
    const card = page.getByTestId("media-card");
    const image = card.getByRole("img", { name: "Generated image" });
    await expect(image).toBeVisible({ timeout: 180_000 });
    await expect
      .poll(() => image.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)))
      .toBeGreaterThan(0);
    await expect(card.getByText("Done", { exact: true })).toBeVisible();
    await expect(card.getByText("generate_image", { exact: true })).toBeVisible();

    const firstTurn = await waitConversationIdle(page, id, 120_000);
    expect(firstTurn.status).toBe("done");
    expect(toolResults(firstTurn, "generate_image")).toHaveLength(1);

    // 接口：生成完成、引用了附件那张参考图
    const media = await apiOk<MediaGeneration[]>(page, `/conversations/${id}/media`);
    const generated = media.find((g) => g.versions.some((v) => v.prompt.includes(tag)));
    if (!generated) throw new Error("generated image is not listed in /conversations/:id/media");
    const version = generated.versions[0];
    expect(version.status).toBe("done");
    expect(version.referenceVersionIds).toHaveLength(1);

    // 同步进工作区：<workspace>/media/<versionId>/<文件名>
    await sendMessage(
      page,
      id,
      "用 sync_media_to_sandbox 把刚生成的那张图同步到工作区，然后只回复它在工作区里的路径。不要调用其它工具。",
    );
    const synced = await waitConversationIdle(page, id, 300_000);
    expect(synced.status).toBe("done");
    const syncResult = toolResults(synced, "sync_media_to_sandbox").map(contentText).join("\n");
    expect(syncResult).toContain(`/media/${version.id}/`);

    // 文件面板：media/<versionId>/ 出现
    const sheet = await openSandboxPanel(page);
    await sheet.getByRole("button", { name: "media", exact: true }).click();
    await expect(sheet.getByRole("button", { name: version.id, exact: true })).toBeVisible();
  } finally {
    rmSync(refFile, { force: true });
  }
});
