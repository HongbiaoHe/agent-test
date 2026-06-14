import { auth } from "@/auth";
import { NextResponse } from "next/server";

// 需要登录的受保护区域
const PROTECTED_PREFIXES = ["/agent", "/conversations", "/skills"];

// SSR 守卫（无闪烁，在服务端直接重定向）：
// - 已登录访问 /login → 默认进 /agent
// - 未登录访问受保护页 → 跳 /login
// - /api-backend/* 注入 backendToken 到 Authorization header，不再让客户端逐次调 getSession()
// 首页 / 是公开 landing，对所有人放行（已从 matcher 移除，中间件不会跑到它）。
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = Boolean(req.auth);

  // API 反代：从 session 取 backendToken 注入 Authorization header，
  // 使客户端 api.ts 不再需要 getSession()
  if (pathname.startsWith("/api-backend/")) {
    const token = (req.auth as { backendToken?: string } | null)?.backendToken;
    if (token) {
      const headers = new Headers(req.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  // 不要用 req.nextUrl.origin：Next 16 dev 把 req.url 规范化成 http://localhost:3100
  // （5d4c225 实测 /api/echo-host：headers.host=192.168.1.4 而 req.url=localhost），
  // 手机经 ngrok/内网 IP 访问时会被重定向到不可达的 localhost。改从请求头还原真实访问地址。
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3100";
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const base = `${proto}://${host}`;

  if (isLoggedIn && pathname === "/login") {
    return Response.redirect(new URL("/agent", base));
  }

  const needsAuth = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
  if (!isLoggedIn && needsAuth) {
    return Response.redirect(new URL("/login", base));
  }
});

export const config = {
  matcher: [
    "/login",
    "/agent/:path*",
    "/conversations/:path*",
    "/skills/:path*",
    "/api-backend/:path*",
  ],
};
