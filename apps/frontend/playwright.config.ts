import { defineConfig } from "@playwright/test";

// Web 端到端（apps/frontend/e2e，说明见 e2e/README.md）：直接连已经在跑的本地服务，不配 webServer。
// 跑之前先用 preview 起好 frontend（:3100）和 backend（:3101，见 .claude/launch.json 的
// "frontend" / "backend"）；前端经 /api-backend/* 反代到后端。
// 浏览器用本机 Google Chrome（channel: "chrome"），不下载 Playwright 自带浏览器。
// 登录按 spec 文件各自进行（helpers.ts 的 loggedInAs），没有全局 setup project。
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.WEB_E2E_BASE_URL ?? "http://localhost:3100",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
