// Web e2e 公共工具（所有 spec 共用，接口保持稳定；按功能区的工具放 e2e/helpers/<area>.ts）。
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import type { Conversation } from "@/lib/api";

/** 存验证码限流 key 的 Redis 容器（docker compose 起的本地 Redis）。 */
export const REDIS_CONTAINER = process.env.WEB_E2E_REDIS_CONTAINER ?? "agent-test-redis-1";

// ---- 登录 ----

/** 某个测试邮箱的登录态文件（e2e/.auth/ 已 gitignore）。 */
export function authFile(email: string): string {
  return `e2e/.auth/${email}.json`;
}

/**
 * 在 page 里按指定邮箱走完整登录：清限流 → 发验证码 → 登录，结束时停在登录后的页面（/agent）。
 * 后端没配 RESEND_API_KEY 时 /auth/send-code 直接返回验证码、登录页自动填入；
 * 每个邮箱 60 秒只能发一次验证码（Redis key `auth:code:limit:<email>`），先删掉它，连跑不会被挡。
 * 账号不存在时后端自动注册。
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  execFileSync("docker", [
    "exec",
    REDIS_CONTAINER,
    "redis-cli",
    "DEL",
    `auth:code:limit:${email}`,
  ]);

  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // 测试模式：验证码自动填入
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify & Sign in" }).click();
  await page.waitForURL(/\/agent/);
}

/**
 * 在 spec 文件顶层调用：本文件的用例都以 email 登录。
 * beforeAll 用一个独立上下文跑一次 loginAs，把登录态存到 authFile(email)；
 * 之后每条用例的 context 都从这个 storageState 起（cookie 带登录态，localStorage 只有登录页写的邮箱）。
 */
export function loggedInAs(email: string): void {
  test.use({ storageState: authFile(email) });
  test.beforeAll(async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: undefined,
    });
    const page = await context.newPage();
    try {
      await loginAs(page, email);
      await context.storageState({ path: authFile(email) });
    } finally {
      await context.close();
    }
  });
}

// ---- 接口 ----

export interface ApiResponse<T> {
  /** HTTP 状态码 */
  status: number;
  /** 后端业务码，0 = 成功 */
  code: number;
  message: string;
  data: T;
}

export interface ApiInit {
  method?: string;
  /** JSON 请求体（会被 JSON.stringify） */
  body?: unknown;
}

interface Envelope {
  code: number;
  message: string;
  data: unknown;
}

function isEnvelope(v: unknown): v is Envelope {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    typeof v.code === "number" &&
    "message" in v &&
    "data" in v
  );
}

/**
 * 以当前登录用户调后端：走前端同源的 /api-backend/* 反代，Authorization 由 Next middleware
 * 从 next-auth session 注入。用 page.request（与页面所在的浏览器上下文共用 cookie），
 * 页面不必先打开任何地址。不断言成功——要拿 4xx/业务错误码时用它，否则用 apiOk。
 */
export async function api<T>(page: Page, path: string, init: ApiInit = {}): Promise<ApiResponse<T>> {
  const method = init.method ?? "GET";
  const res = await page.request.fetch(`/api-backend${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    data: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body: unknown = await res.json();
  if (!isEnvelope(body)) {
    throw new Error(`${method} ${path}: unexpected response ${JSON.stringify(body)}`);
  }
  // data 的形状由调用方按接口声明（我方后端的 {code,message,data} 包），这里只校验外壳
  return { status: res.status(), code: body.code, message: body.message, data: body.data as T };
}

/** 调接口并断言业务成功（code === 0），直接返回 data。 */
export async function apiOk<T>(page: Page, path: string, init: ApiInit = {}): Promise<T> {
  const res = await api<T>(page, path, init);
  expect(res.code, `${init.method ?? "GET"} ${path}: ${res.message}`).toBe(0);
  return res.data;
}

// ---- 会话 ----

/** GET /conversations/:id 的完整返回：前端 Conversation 类型之外还带了会话的 model。 */
export type ConversationDetail = Conversation & { model: string | null };

export function getConversation(page: Page, id: string): Promise<ConversationDetail> {
  return apiOk<ConversationDetail>(page, `/conversations/${id}`);
}

/** 删除会话（后端先按「停止」收尾再软删，运行中的也能删）——用例清理用。 */
export async function deleteConversation(page: Page, id: string): Promise<void> {
  await apiOk(page, `/conversations/${id}`, { method: "DELETE" });
}

/**
 * 轮询会话 status，直到这一轮结束（不再是 running / queued），返回此刻的完整会话。
 * 结束态可能是 done / failed / stopped / waiting_approval，由调用方断言期望的那个。
 */
export async function waitConversationIdle(
  page: Page,
  id: string,
  timeoutMs = 180_000,
): Promise<ConversationDetail> {
  await expect
    .poll(async () => (await getConversation(page, id)).status, {
      timeout: timeoutMs,
      intervals: [1_000, 2_000],
    })
    .not.toMatch(/^(running|queued)$/);
  return getConversation(page, id);
}

/** 会话里 assistant 消息内容拼成的文本（content 结构不定，非字符串的统一 JSON 序列化后匹配）。 */
export function assistantText(conv: Pick<ConversationDetail, "messages">): string {
  return conv.messages
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** 从 /agent/<id> 地址里取会话 id。 */
export function conversationIdFromUrl(page: Page): string {
  const match = /\/agent\/([^/?#]+)/.exec(page.url());
  if (!match) throw new Error(`not on a conversation page: ${page.url()}`);
  return match[1];
}

// ---- 杂项 ----

/** 8 位大写随机串：给本次运行建的数据打标记（名称、模型应答暗号等），避免与旧数据混淆。 */
export function uniqueTag(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "0");
}
