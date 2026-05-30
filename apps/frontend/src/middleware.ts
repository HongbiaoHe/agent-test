import { auth } from "@/auth";

// SSR 守卫：未登录访问 /agent 在服务端直接重定向到 /login（无闪烁）
export default auth((req) => {
  if (!req.auth && req.nextUrl.pathname.startsWith("/agent")) {
    return Response.redirect(new URL("/login", req.nextUrl.origin));
  }
});

export const config = {
  matcher: ["/agent/:path*", "/conversations/:path*"],
};
