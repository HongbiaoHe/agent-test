import { expect, type Locator, type Page, test } from "@playwright/test";

import { loggedInAs } from "./helpers";
import {
  addVirtualAuthenticator,
  deleteAllPasskeys,
  getMe,
  type VirtualAuthenticator,
  virtualCredentials,
} from "./helpers/profile";

// 个人资料：账户信息展示、passkey 注册 / 删除、用 passkey 登录。
// passkey 走 Chrome 的 CDP 虚拟验证器（WebAuthn 域），RP ID = localhost、origin = http://localhost:3100
// （前端按当前地址带上 rpId/origin，后端缺省值同为 localhost）。afterEach 用接口删光本账号的 passkey。

const EMAIL = "e2e-web-profile@example.test";
loggedInAs(EMAIL);

test.beforeEach(async ({ browser }, testInfo) => {
  await deleteAllPasskeys(browser, EMAIL, testInfo);
});

test.afterEach(async ({ browser }, testInfo) => {
  await deleteAllPasskeys(browser, EMAIL, testInfo);
});

function passkeysCard(page: Page): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Passkeys", { exact: true }) });
}

/** Account 卡片里某一项（dt 标签）的值（dd）。 */
function accountField(page: Page, label: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("Account", { exact: true }) })
    .locator("dl > div")
    .filter({ has: page.locator("dt").getByText(label, { exact: true }) })
    .locator("dd");
}

/** 资料页上走完「Add passkey → Confirm & continue」，由虚拟验证器完成注册，等列表出现这一行。 */
async function registerPasskey(page: Page, auth: VirtualAuthenticator) {
  const card = passkeysCard(page);
  await card.getByRole("button", { name: "Add passkey" }).click();
  // 先内联确认绑定的邮箱
  await expect(card.getByText(`This passkey will be bound to ${EMAIL}.`, { exact: false })).toBeVisible();
  const verified = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api-backend/users/me/passkeys/verify"),
  );
  await card.getByRole("button", { name: "Confirm & continue" }).click();
  expect((await verified).ok()).toBe(true);
  await expect(card.getByRole("button", { name: "Delete passkey" })).toHaveCount(1);

  // 验证器里存下了一把 localhost 的 resident key
  const creds = await virtualCredentials(auth);
  expect(creds).toHaveLength(1);
  expect(creds[0].rpId).toBe("localhost");
  expect(creds[0].isResidentCredential).toBe(true);
}

test("profile page shows the current account", async ({ page }) => {
  const me = await getMe(page);
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

  await expect(accountField(page, "Email")).toHaveText(EMAIL);
  await expect(accountField(page, "Workspace")).toHaveText(me.tenantName);
  await expect(accountField(page, "Member since")).toHaveText(new Date(me.createdAt).toLocaleDateString("en-US"));
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  // 没有 passkey 时的空态
  await expect(passkeysCard(page).getByText(/^No passkeys yet/)).toBeVisible();
});

test("add a passkey, see it listed, then delete it", async ({ page }) => {
  const auth = await addVirtualAuthenticator(page);
  await page.goto("/settings/profile");
  const card = passkeysCard(page);
  await expect(card.getByText(/^No passkeys yet/)).toBeVisible();

  await registerPasskey(page, auth);
  const [pk] = (await getMe(page)).passkeys;
  expect(pk).toBeDefined();
  expect(pk.lastUsedAt).toBeNull();
  await expect(card.getByText(pk.providerName, { exact: true })).toBeVisible();
  await expect(card.getByText("Never used", { exact: true })).toBeVisible();

  // 删除要两步确认：先 Cancel 不删，再 Confirm delete
  await card.getByRole("button", { name: "Delete passkey" }).click();
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Delete passkey" })).toHaveCount(1);
  await card.getByRole("button", { name: "Delete passkey" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).click();

  await expect(card.getByText(/^No passkeys yet/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete passkey" })).toHaveCount(0);
  expect((await getMe(page)).passkeys).toHaveLength(0);
});

test("sign out, then sign in with the passkey", async ({ page }) => {
  // 虚拟验证器挂在这个页面（CDP target）上：退出、登录都在同一个页面里导航，凭据一直在
  const auth = await addVirtualAuthenticator(page);
  await page.goto("/settings/profile");
  await registerPasskey(page, auth);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(/\/login$/);
  // 已退出：受保护页面跳回登录
  await page.goto("/settings/profile");
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fprofile$/);

  await page.getByLabel("Email address").fill(EMAIL);
  const verified = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api-backend/auth/passkey/login/verify"),
  );
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  expect((await verified).ok()).toBe(true);
  // 登录后回到 next 指向的资料页
  await page.waitForURL(/\/settings\/profile$/);

  const me = await getMe(page);
  expect(me.email).toBe(EMAIL);
  expect(me.passkeys).toHaveLength(1);
  expect(me.passkeys[0].lastUsedAt).not.toBeNull();
  await expect(passkeysCard(page).getByText(/^Last used /)).toBeVisible();
  await expect(accountField(page, "Email")).toHaveText(EMAIL);

  // 不带 next 直接从登录页用 passkey 登录：进入 /agent
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(/\/login$/);
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await page.waitForURL(/\/agent$/);
  expect((await getMe(page)).email).toBe(EMAIL);
});
