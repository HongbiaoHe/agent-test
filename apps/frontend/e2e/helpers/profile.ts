// profile 用例专用的工具：当前用户信息、passkey 清理、CDP 虚拟验证器。
import type { Browser, CDPSession, Page, TestInfo } from "@playwright/test";

import type { MeInfo } from "@/lib/api";

import { apiOk, authFile } from "../helpers";

export function getMe(page: Page): Promise<MeInfo> {
  return apiOk<MeInfo>(page, "/users/me");
}

/**
 * 清理：删掉账号下全部 passkey（账号专用，留下的只可能是本套用例建的）。
 * 用一个从登录态文件起的新上下文调接口——用例里的页面可能已经退出登录。
 */
export async function deleteAllPasskeys(browser: Browser, email: string, testInfo: TestInfo): Promise<void> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: authFile(email),
  });
  try {
    const page = await context.newPage();
    for (const pk of (await getMe(page)).passkeys) {
      await apiOk(page, `/users/me/passkeys/${pk.id}`, { method: "DELETE" });
    }
  } finally {
    await context.close();
  }
}

export interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
}

/**
 * 给这个页面（CDP target）挂一个平台型虚拟验证器：ctap2 / internal（= 平台认证器，对应注册 options 的
 * authenticatorAttachment: platform）、可存 resident key、用户验证自动通过。同一页面内导航后仍然有效。
 */
export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { cdp, authenticatorId };
}

export async function virtualCredentials(auth: VirtualAuthenticator) {
  const { credentials } = await auth.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: auth.authenticatorId,
  });
  return credentials;
}
