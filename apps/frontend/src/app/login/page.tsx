"use client";

import { Loader2, Mail, Sparkles } from "lucide-react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setError("");
    if (!EMAIL_RE.test(email)) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setLoading(true);
    const res = await signIn("credentials", { email, redirect: false });
    if (res?.error) {
      setError("登录失败，请重试");
      setLoading(false);
    } else {
      router.push("/agent");
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm border bg-card p-8 shadow-sm">
        {/* 品牌区（呼应 sidebar） */}
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Agent</h1>
            <p className="mt-1 text-sm text-muted-foreground">任务自动化平台</p>
          </div>
        </div>

        {/* 表单 */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              邮箱
            </label>
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSubmit();
                }}
                className="pl-9"
                disabled={loading}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={() => void handleSubmit()}
            disabled={loading || !email}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 登录中…
              </>
            ) : (
              "登录"
            )}
          </Button>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          输入邮箱即可登录（开发模式，账户自动创建）
        </p>
      </Card>
    </main>
  );
}
