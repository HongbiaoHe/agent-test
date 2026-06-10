"use client";

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Loader2, Mail, Sparkles } from "lucide-react";
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
    if (name === "NotAllowedError" || name === "AbortError") return "已取消";
    return e instanceof Error ? e.message : "操作失败，请重试";
  }

  async function finishWithToken(token: string, value: string) {
    const res = await signIn("credentials", { token, redirect: false });
    if (res?.error) {
      setError("登录失败，请重试");
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
      setError("使用 Passkey 登录前请先填写邮箱");
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
      setError("注册 Passkey 需要先填写邮箱");
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
      setError("请输入有效的邮箱地址");
      return;
    }
    setBusy("email");
    const res = await signIn("credentials", { email: value, redirect: false });
    if (res?.error) {
      setError("登录失败，请重试");
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
            <h1 className="text-xl font-semibold tracking-tight">欢迎回来</h1>
            <p className="text-sm text-muted-foreground">登录到任务自动化平台</p>
          </div>
        </div>

        {/* Passkey 登录（主） */}
        <Button
          className="h-11 w-full text-sm"
          onClick={() => void passkeyLogin()}
          disabled={busy !== null}
        >
          {busy === "passkey-login" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> 验证中…
            </>
          ) : (
            <>
              <Fingerprint className="size-4" /> 使用 Passkey 登录
            </>
          )}
        </Button>

        {/* 分隔 */}
        <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
          <Separator className="flex-1" />
          或使用邮箱
          <Separator className="flex-1" />
        </div>

        {/* 邮箱：兜底登录 + 注册 Passkey */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="text-sm font-medium text-foreground"
            >
              邮箱
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
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
            variant="secondary"
            className="h-11 w-full text-sm"
            onClick={() => void emailLogin()}
            // 不再依赖 state 判空禁用：iOS 自动填充不触发 onChange，state 为空会把按钮永久锁灰。
            // 改为点击后校验（effectiveEmail 经 ref 读 DOM 真实值），无效时给出错误提示。
            disabled={busy !== null}
          >
            {busy === "email" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 登录中…
              </>
            ) : (
              "邮箱登录"
            )}
          </Button>
        </div>

        {/* 注册（弱化为底部入口） */}
        <div className="mt-6 space-y-3 border-t pt-5 text-center">
          <p className="text-xs text-muted-foreground">
            首次使用？填写邮箱后注册 Passkey，之后即可一键登录。
          </p>
          <Button
            variant="ghost"
            className="h-9 w-full text-sm"
            onClick={() => void passkeyRegister()}
            disabled={busy !== null} // 同邮箱登录按钮：判空交给点击后校验（iOS 自动填充兼容）
          >
            {busy === "passkey-register" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 注册中…
              </>
            ) : (
              <>
                <KeyRound className="size-4" /> 用该邮箱注册 Passkey
              </>
            )}
          </Button>
        </div>
      </Card>
    </main>
  );
}
