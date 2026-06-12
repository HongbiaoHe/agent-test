"use client";

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { Fingerprint, Loader2, Mail, Sparkles } from "lucide-react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
} from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 仅缓存最近一次成功登录/注册用的邮箱，下次进来自动预填
const LAST_EMAIL_KEY = "lastLoginEmail";

type Busy = null | "passkey-login" | "passkey-register" | "email";

/** Apple 品牌图标（lucide 无品牌图标，currentColor 跟随主题） */
function AppleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-.702" />
    </svg>
  );
}

/** Google 品牌图标（lucide 无品牌图标，brand 色为官方固定色，不走主题 token） */
function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.28a7.21 7.21 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  // iOS Safari 的自动填充会直接写 DOM、不触发 React onChange——受控 state 仍是空串，
  // 提交/校验若只看 state 会误判"没填"。这里提交时经 ref 兜底读 DOM 真实值。
  const emailInputRef = useRef<HTMLInputElement>(null);

  /** 提交时的有效邮箱：DOM 真实值优先（覆盖自动填充场景），并回写 state 保持受控一致。 */
  function effectiveEmail(): string {
    const domValue = emailInputRef.current?.value?.trim() ?? "";
    const value = domValue || email.trim();
    if (value !== email) setEmail(value);
    return value;
  }

  // 挂载时回填上次登录的邮箱（仅客户端读 localStorage，避免 SSR 水合不一致）
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_EMAIL_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 一次性挂载初始化，非持续同步
      if (saved) setEmail(saved);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, []);

  // 登录/注册成功后记下当前邮箱（只留最新一个）
  function rememberEmail(value: string) {
    try {
      localStorage.setItem(LAST_EMAIL_KEY, value);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  // passkey 仪式被用户取消时浏览器抛 NotAllowedError，统一成友好提示
  function friendly(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "AbortError") return "Cancelled";
    return e instanceof Error ? e.message : "Something went wrong, please try again";
  }

  async function finishWithToken(token: string, value: string) {
    const res = await signIn("credentials", { token, redirect: false });
    if (res?.error) {
      setError("Sign-in failed, please try again");
      setBusy(null);
    } else {
      rememberEmail(value);
      router.push("/agent");
    }
  }

  async function passkeyLogin() {
    setError("");
    const value = effectiveEmail();
    if (!EMAIL_RE.test(value)) {
      setError("Enter your email before signing in with a passkey");
      return;
    }
    setBusy("passkey-login");
    try {
      const { flowId, options } = await passkeyLoginOptions(value);
      const response = await startAuthentication({ optionsJSON: options });
      const { token } = await passkeyLoginVerify(flowId, response);
      await finishWithToken(token, value);
    } catch (e) {
      setError(friendly(e));
      setBusy(null);
    }
  }

  async function passkeyRegister() {
    setError("");
    const value = effectiveEmail();
    if (!EMAIL_RE.test(value)) {
      setError("Enter your email before registering a passkey");
      return;
    }
    setBusy("passkey-register");
    try {
      const options = await passkeyRegisterOptions(value);
      const response = await startRegistration({ optionsJSON: options });
      const { token } = await passkeyRegisterVerify(value, response);
      await finishWithToken(token, value);
    } catch (e) {
      setError(friendly(e));
      setBusy(null);
    }
  }

  async function emailLogin() {
    setError("");
    const value = effectiveEmail();
    if (!EMAIL_RE.test(value)) {
      setError("Enter a valid email address");
      return;
    }
    setBusy("email");
    const res = await signIn("credentials", { email: value, redirect: false });
    if (res?.error) {
      setError("Sign-in failed, please try again");
      setBusy(null);
    } else {
      rememberEmail(value);
      router.push("/agent");
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-sm gap-0 bg-card p-8 shadow-sm">
        {/* 品牌区 */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground">Sign in to the task automation platform</p>
          </div>
        </div>

        {/* 邮箱优先：输入框 + Continue */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="Email address"
                aria-label="Email address"
                ref={emailInputRef}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void emailLogin();
                }}
                className="h-11 pl-9"
                aria-invalid={Boolean(error)}
                disabled={busy !== null}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <Button
            className="h-11 w-full text-sm"
            onClick={() => void emailLogin()}
            // 不再依赖 state 判空禁用：iOS 自动填充不触发 onChange，state 为空会把按钮永久锁灰。
            // 改为点击后校验（effectiveEmail 经 ref 读 DOM 真实值），无效时给出错误提示。
            disabled={busy !== null}
          >
            {busy === "email" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Signing in…
              </>
            ) : (
              "Continue"
            )}
          </Button>
        </div>

        {/* 注册入口：复用 passkey 注册流程（需先填邮箱） */}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
            onClick={() => void passkeyRegister()}
            disabled={busy !== null}
          >
            {busy === "passkey-register" ? "Registering…" : "Sign up"}
          </button>
        </p>

        {/* 分隔 */}
        <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
          <Separator className="flex-1" />
          or
          <Separator className="flex-1" />
        </div>

        {/* 第三方 / 快捷登录按钮组 */}
        <div className="space-y-3">
          {/* Google / Apple 暂为纯 UI 占位，点击不触发任何逻辑 */}
          <Button variant="outline" className="h-11 w-full text-sm" disabled={busy !== null}>
            <GoogleIcon /> Continue with Google
          </Button>
          <Button variant="outline" className="h-11 w-full text-sm" disabled={busy !== null}>
            <AppleIcon /> Continue with Apple
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full text-sm"
            onClick={() => void passkeyLogin()}
            disabled={busy !== null}
          >
            {busy === "passkey-login" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Verifying…
              </>
            ) : (
              <>
                <Fingerprint className="size-4" /> Continue with passkey
              </>
            )}
          </Button>
        </div>

        {/* 条款占位 */}
        <p className="mt-8 text-center text-xs text-muted-foreground">
          <a href="#" className="underline underline-offset-4 hover:text-foreground">
            Terms of Use
          </a>
          <span className="mx-2">|</span>
          <a href="#" className="underline underline-offset-4 hover:text-foreground">
            Privacy Policy
          </a>
        </p>
      </Card>
    </main>
  );
}
