// chat 用例专用的工具：新建会话、发消息、按消息类型取文本、生成测试图片。
import { crc32, deflateSync } from "node:zlib";

import { expect, type Page } from "@playwright/test";

import type { ConversationMessage } from "@/lib/api";

import { apiOk, type ConversationDetail, conversationIdFromUrl } from "../helpers";

export const COMPOSER_PLACEHOLDER = "Message the agent… (try typing /)";

/** 在 /agent 点「New conversation」，返回新会话 id（调用方负责记入清理列表）。 */
export async function newConversation(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New conversation", exact: true }).first().click();
  await page.waitForURL(/\/agent\/[^/]+$/);
  return conversationIdFromUrl(page);
}

/** 在输入框发一条消息，等 POST /messages 返回（此时会话已是 queued）。 */
export async function sendMessage(page: Page, conversationId: string, text: string): Promise<void> {
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(text);
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api-backend/conversations/${conversationId}/messages`),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await posted).ok()).toBe(true);
}

/** GET /conversations/:id 的会话行还带思考档位（公共 ConversationDetail 没声明）。 */
export type ChatConversation = ConversationDetail & { thinkingLevel: string | null };

export function getChatConversation(page: Page, id: string): Promise<ChatConversation> {
  return apiOk<ChatConversation>(page, `/conversations/${id}`);
}

/** 消息 content 的文本形式（非字符串统一 JSON 序列化后匹配）。 */
export function contentText(m: ConversationMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/**
 * assistant 的正文回复（type === "message"），可只取 seq 之后的。
 * 不用公共 assistantText：它把 control_request（审批 / 提问的全部参数）、tool_start 也算进去，
 * 选项标签、邮件主题等会混进「回复」里，断言就失去意义。
 */
export function replyText(conv: Pick<ConversationDetail, "messages">, afterSeq = -1): string {
  return conv.messages
    .filter((m) => m.role === "assistant" && m.type === "message" && m.seq > afterSeq)
    .map(contentText)
    .join("\n");
}

/** 某个工具的结果消息（tool_end，按工具名过滤）。 */
export function toolResults(
  conv: Pick<ConversationDetail, "messages">,
  toolName: string,
): ConversationMessage[] {
  return conv.messages.filter(
    (m) =>
      m.type === "tool_end" &&
      typeof m.content === "object" &&
      m.content !== null &&
      "name" in m.content &&
      m.content.name === toolName,
  );
}

/** 生成一张纯色 PNG（RGB，无压缩依赖），给附件上传用。 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.alloc(1 + width * 3); // 每行前置 filter 字节 0
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
