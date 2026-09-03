import { auth } from "@/auth";
import { NextResponse } from "next/server";

import { safeNextPath } from "@/lib/safe-next";

// 需要登录的受保护区域
const PROTECTED_PREFIXES = [
  "/agent",
  // 带斜杠：只盖 /canvas/[id]（画布本体），精确的 /canvas 是公开的产品介绍页——
  // 落地页要能把未登录访客直接送进去，弹去 /login 就白搭了。
  "/canvas/",
  // 索引页是「我的画布」，得登录；它不被 "/canvas/" 命中，必须单列
  "/canvas-list",
  "/conversations",
  "/skills",
  "/settings",
];

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

  // 已登录还去登录页：优先回 next 指的地方（从画布 CTA 点进来的就该落回画布），
  // 没有或不合法才回缺省的 /agent
  if (isLoggedIn && pathname === "/login") {
    const next = safeNextPath(req.nextUrl.searchParams.get("next"));
    return Response.redirect(new URL(next ?? "/agent", base));
  }

  const needsAuth = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
  if (!isLoggedIn && needsAuth) {
    // 把「本来要去哪」带上：登录完直接送回去，而不是一律丢进 /agent
    const target = new URL("/login", base);
    const next = safeNextPath(pathname + req.nextUrl.search);
    if (next) target.searchParams.set("next", next);
    return Response.redirect(target);
  }
});

export const config = {
  matcher: [
    "/login",
    "/agent/:path*",
    "/canvas/:path*",
    // /canvas-list 不被 "/canvas/:path*" 命中（差一个分隔符），要单列一条才会进中间件
    "/canvas-list",
    "/conversations/:path*",
    "/skills/:path*",
    "/settings/:path*",
    "/api-backend/:path*",
  ],
};
