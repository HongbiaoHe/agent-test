import type { NextConfig } from "next";

const BACKEND = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3101";

const nextConfig: NextConfig = {
  // Lab 的 3D 页面要求「无任何 UI 元素」，开发态左下角的 Next 指示器也一并关掉
  devIndicators: false,
  // 共享 UI 包直接发 TS 源码（无构建步骤），由 Next 编译：shadcn 基础组件 + 画布编辑区
  transpilePackages: ["@agent-test/ui", "@agent-test/canvas-ui"],
  // 允许经 ngrok 隧道域名访问 dev 资源（/_next/*）。否则 Next 16 dev 默认拦截跨源请求，
  // 导致隧道下页面拿不到 JS chunk、无法 hydrate（表现为按钮一直禁用、点击无反应）。
  // 通配子域：随机/固定 ngrok 域名均无需改配置重启（官方文档确认支持 *.）。
  // .dev 与 .app 都要：实测 ngrok v3.34.1 随机域名发 *.ngrok-free.dev，固定域名仍是 *.ngrok-free.app。
  allowedDevOrigins: ["localhost", "*.ngrok-free.app", "*.ngrok-free.dev"],
  // 不对带尾斜杠的请求做 308 重定向，否则 socket.io 的 /api-backend/socket.io/?... 会被重定向而握手失败
  skipTrailingSlashRedirect: true,
  // 浏览器侧经同源前缀 /api-backend/* 反代到后端，使单条 ngrok 隧道（仅暴露 3100）即可全功能。
  // 用独立前缀避免与前端的 /conversations 页面路由冲突；socket.io 也走这个前缀。
  async rewrites() {
    return [
      // socket.io 的引擎端点必须保留尾斜杠 /socket.io/，否则后端 404；用字面量映射避免 :path* 吃掉尾斜杠
      {
        source: "/api-backend/socket.io/",
        destination: `${BACKEND}/socket.io/`,
      },
      {
        source: "/api-backend/socket.io",
        destination: `${BACKEND}/socket.io/`,
      },
      {
        source: "/api-backend/:path*",
        destination: `${BACKEND}/:path*`,
      },
      // 画布 MCP 对外服务（第三方 agent 经 MCP 操作画布）：协议规定发现元数据挂在域名根，
      // MCP 端点与 OAuth 端点也对外用主站域名，原路径透传给后端（见后端 mcp-server.http.ts）。
      // /oauth/consent 是前端同意页，不在这里
      { source: "/mcp", destination: `${BACKEND}/mcp` },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: `${BACKEND}/.well-known/oauth-authorization-server`,
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: `${BACKEND}/.well-known/oauth-protected-resource/:path*`,
      },
      {
        source: "/oauth/:endpoint(authorize|token|register|revoke)",
        destination: `${BACKEND}/oauth/:endpoint`,
      },
    ];
  },
  // OAuth 同意页禁止被嵌入：防止恶意页面把它套进 iframe 诱导用户点「允许」（点击劫持）
  async headers() {
    return [
      {
        source: "/oauth/consent",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
