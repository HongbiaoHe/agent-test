import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// 服务端直连后端（绝对地址）：NEXT_PUBLIC_API_BASE_URL 现在是浏览器侧同源前缀（/api-backend），
// 服务端 fetch 不能用相对路径，故走内网直连地址。
const API_BASE = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:3101";

/** 从后端 JWT 解出 email（仅用于展示，不做验签——token 由后端刚签发并经本源传回）。 */
function decodeJwtEmail(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return (JSON.parse(json) as { email?: string }).email;
  } catch {
    return undefined;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  // 信任反代/隧道转发的 Host（配合 AUTH_TRUST_HOST），ngrok 域名下也能正确生成回调地址
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      // email：邮箱验证登录；code：验证码；token：passkey 已在后端验证并签发，直接桥接
      credentials: { email: {}, code: {}, token: {} },
      async authorize(credentials) {
        // Passkey 路径：后端 PasskeyService 验证通过后给的 backendToken，直接使用
        const token = credentials?.token as string | undefined;
        if (token) {
          const email = decodeJwtEmail(token) ?? "passkey-user";
          return { id: email, email, backendToken: token };
        }
        // 邮箱登录：调 NestJS /auth/login 验证验证码并拿后端标准 JWT
        const email = credentials?.email as string | undefined;
        const code = credentials?.code as string | undefined;
        if (!email || !code) return null;
        const res = await fetch(`${API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code }),
        });
        const body = (await res.json()) as {
          code: number;
          message?: string;
          data?: { token: string };
        };
        if (body.code !== 0 || !body.data) {
          if (body.message) {
            throw new Error(body.message);
          }
          return null;
        }
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
