import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { api, loginAs, REDIS_CONTAINER } from "./helpers";

// 登录 / 退出：每条用例都从未登录的全新上下文开始（不用 loggedInAs），走真实的邮箱验证码流程。
// 后端是测试模式（无 RESEND_API_KEY）：/auth/send-code 直接返回验证码，登录页自动填入。

const EMAIL = "e2e-web-auth@example.test";

/** 每个邮箱 60 秒只能发一次验证码：发之前先删限流 key（同 helpers.loginAs）。 */
function clearCodeRateLimit(email: string) {
  execFileSync("docker", ["exec", REDIS_CONTAINER, "redis-cli", "DEL", `auth:code:limit:${email}`]);
}

/** 登录卡里的提示行（role=alert）；限定在 main 里，排除 Next 的路由播报器（同为 role=alert）。 */
function loginAlert(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

/** 打开登录页、填邮箱、点 Continue，返回自动填入的 6 位验证码。 */
async function requestCode(page: Page, email: string): Promise<string> {
  clearCodeRateLimit(email);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const codeInput = page.getByLabel("Verification code");
  await expect(codeInput).toHaveValue(/^\d{6}$/);
  return codeInput.inputValue();
}

test("visiting /agent signed out redirects to /login", async ({ page }) => {
  await page.goto("/agent");
  await expect(page).toHaveURL(/\/login\?next=%2Fagent$/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("email code sign-in lands on /agent and shows the email", async ({ page }) => {
  const code = await requestCode(page, EMAIL);
  // 测试模式会把验证码明文提示出来
  await expect(loginAlert(page)).toHaveText(
    `Testing environment: Your verification code is ${code} (auto-filled)`,
  );
  // 邮箱框在验证码阶段锁定
  await expect(page.getByLabel("Email address")).toBeDisabled();

  await page.getByRole("button", { name: "Verify & Sign in" }).click();
  await page.waitForURL(/\/agent$/);

  // 侧栏底部用户区显示邮箱
  await expect(page.getByRole("complementary").getByText(EMAIL, { exact: true })).toBeVisible();
  // 已登录：后端接口可用
  expect((await api(page, "/conversations")).code).toBe(0);
});

test("sign out from the profile page, then protected pages go back to /login", async ({ page }) => {
  await loginAs(page, EMAIL);

  // 退出入口在 设置 → Profile 的 Account 卡片（account-card.tsx）
  await page.goto("/settings/profile");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(/\/login$/);

  for (const path of ["/agent", "/conversations", "/settings/profile"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}$`));
  }
  // 会话 cookie 已清：反代不再注入 token，后端 401
  expect((await api(page, "/conversations")).status).toBe(401);
});

test("a wrong verification code shows an error and does not sign in", async ({ page }) => {
  const code = await requestCode(page, EMAIL);
  const wrong = code === "000000" ? "111111" : "000000";

  const codeInput = page.getByLabel("Verification code");
  await codeInput.fill(wrong);
  await page.getByRole("button", { name: "Verify & Sign in" }).click();

  await expect(loginAlert(page)).toHaveText("Verification failed or invalid code");
  await expect(page).toHaveURL(/\/login$/);
  expect((await api(page, "/conversations")).status).toBe(401);

  // 输错不作废验证码：改回正确的仍能登录
  await codeInput.fill(code);
  await page.getByRole("button", { name: "Verify & Sign in" }).click();
  await page.waitForURL(/\/agent$/);
});
