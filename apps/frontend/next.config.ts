import type { NextConfig } from "next";

const BACKEND = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3101";

const nextConfig: NextConfig = {
  // 允许经 ngrok 隧道域名访问 dev 资源（/_next/*）。否则 Next 16 dev 默认拦截跨源请求，
  // 导致隧道下页面拿不到 JS chunk、无法 hydrate（表现为按钮一直禁用、点击无反应）。
  allowedDevOrigins: ["localhost"],
  // 不对带尾斜杠的请求做 308 重定向，否则 socket.io 的 /api-backend/socket.io/?... 会被重定向而握手失败
  skipTrailingSlashRedirect: true,
  // 浏览器侧经同源前缀 /api-backend/* 反代到后端，使单条 ngrok 隧道（仅暴露 3000）即可全功能。
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
    ];
  },
};

export default nextConfig;
