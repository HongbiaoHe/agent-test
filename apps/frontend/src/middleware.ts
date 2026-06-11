import { auth } from "@/auth";

// 需要登录的受保护区域
const PROTECTED_PREFIXES = ["/agent", "/conversations", "/skills"];

// SSR 守卫（无闪烁，在服务端直接重定向）：
// - 已登录访问 / 或 /login → 默认进 /agent
// - 未登录访问 / 或受保护页 → 跳 /login
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoggedIn = Boolean(req.auth);

  // 不要用 req.nextUrl.origin：Next 16 dev 把 req.url 规范化成 http://localhost:3100
  // （5d4c225 实测 /api/echo-host：headers.host=192.168.1.4 而 req.url=localhost），
  // 手机经 ngrok/内网 IP 访问时会被重定向到不可达的 localhost。改从请求头还原真实访问地址。
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3100";
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const base = `${proto}://${host}`;

  if (isLoggedIn && (pathname === "/" || pathname === "/login")) {
    return Response.redirect(new URL("/agent", base));
  }

  const needsAuth =
    pathname === "/" ||
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isLoggedIn && needsAuth) {
    return Response.redirect(new URL("/login", base));
  }
});

export const config = {
  matcher: [
    "/",
    "/login",
    "/agent/:path*",
    "/conversations/:path*",
    "/skills/:path*",
  ],
};
