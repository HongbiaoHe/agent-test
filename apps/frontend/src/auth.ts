import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {} },
      // 调 NestJS /auth/login 拿后端标准 JWT；authorize 返回的字段进 jwt callback
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        if (!email) return null;
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const body = (await res.json()) as {
          code: number;
          data?: { token: string };
        };
        if (body.code !== 0 || !body.data) return null;
        return { id: email, email, backendToken: body.data.token };
      },
    }),
  ],
  callbacks: {
    // 把 NestJS 标准 JWT 存进 next-auth 的 token（httpOnly session 内）
    jwt({ token, user }) {
      if (user) {
        token.backendToken = (user as { backendToken?: string }).backendToken;
      }
      return token;
    },
    // 暴露 backendToken 给 client（REST Authorization / socket auth 用）
    session({ session, token }) {
      (session as { backendToken?: string }).backendToken =
        token.backendToken as string | undefined;
      return session;
    },
  },
});
