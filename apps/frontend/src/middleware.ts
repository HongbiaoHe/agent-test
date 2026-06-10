import { auth } from "@/auth";

// 需要登录的受保护区域
const PROTECTED_PREFIXES = ["/agent", "/conversations", "/skills"];

// SSR 守卫（无闪烁，在服务端直接重定向）：
// - 已登录访问 / 或 /login → 默认进 /agent
// - 未登录访问 / 或受保护页 → 跳 /login
export default auth((req) => {
  const { pathname, origin } = req.nextUrl;
  const isLoggedIn = Boolean(req.auth);

  if (isLoggedIn && (pathname === "/" || pathname === "/login")) {
    return Response.redirect(new URL("/agent", origin));
  }

  const needsAuth =
    pathname === "/" ||
    PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isLoggedIn && needsAuth) {
    return Response.redirect(new URL("/login", origin));
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
