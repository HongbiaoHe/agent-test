/**
 * 登录页（参考 Web /login 的版式与交互：点阵背景 + 居中卡片、邮箱优先 → 验证码 → 登录）。
 * 桌面端只有邮箱验证码一种方式；可以「先跳过」——不登录也能用对话、技能、连接器，
 * 只是没有生图 / 生视频 / 配音（这些经 Web 后端调 aigc，必须登录 Web 账号）。
 * Web 后端地址在设置 → 账号里改，这里不出现。
 */
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, Mail, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import DotField from '@/components/dot-field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { WEB_ACCOUNT_KEY } from './use-web-account';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 只记最近一次成功登录的邮箱，下次进来预填（同 Web） */
const LAST_EMAIL_KEY = 'lastLoginEmail';

function lastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function LoginView({
  apiUrl,
  onSkip,
  onDone,
}: {
  apiUrl: string;
  /** 先跳过：不登录直接进入（之后可在侧栏或设置 → 账号里登录） */
  onSkip: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(lastEmail);
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function sendCode() {
    setError('');
    setNotice('');
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setBusy(true);
    try {
      const r = await window.desktop.sendWebCode(value, apiUrl);
      setShowCode(true);
      setCountdown(60);
      if (r.devCode) {
        setCode(r.devCode);
        setNotice(`测试环境：验证码是 ${r.devCode}（已自动填入）`);
      } else {
        setNotice(`验证码已发送到 ${value}`);
      }
      requestAnimationFrame(() => codeRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError('');
    if (code.trim().length !== 6) {
      setError('请输入 6 位验证码');
      return;
    }
    setBusy(true);
    try {
      const s = await window.desktop.signInWeb(email.trim(), code.trim(), apiUrl);
      try {
        localStorage.setItem(LAST_EMAIL_KEY, email.trim());
      } catch {
        // 本地存储不可用：下次不预填而已
      }
      await qc.invalidateQueries({ queryKey: WEB_ACCOUNT_KEY });
      toast.success(`已登录 ${s.email ?? ''}`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证失败或验证码无效');
      setBusy(false);
    }
  }

  const submit = () => void (showCode ? verify() : sendCode());

  return (
    <main className="relative flex h-full items-center justify-center overflow-clip bg-background px-4">
      <div className="app-drag absolute inset-x-0 top-0 h-12" />
      <DotField className="absolute inset-0 z-0" />
      <Card className="relative z-10 w-full max-w-sm gap-0 bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">欢迎使用 Spark</h1>
            <p className="text-sm text-muted-foreground">登录 Web 账号，解锁生图、生视频与配音</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="relative">
            <Mail className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="email"
              autoComplete="email"
              placeholder="邮箱地址"
              aria-label="邮箱地址"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              disabled={busy || showCode}
              className={`h-11 pl-9 ${showCode ? 'cursor-not-allowed bg-muted/50 pr-16 text-muted-foreground' : ''}`}
            />
            {showCode && (
              <button
                type="button"
                onClick={() => {
                  setShowCode(false);
                  setCode('');
                  setNotice('');
                  setError('');
                }}
                disabled={busy}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium text-primary hover:underline"
              >
                修改
              </button>
            )}
          </div>

          {showCode && (
            <div className="space-y-1.5">
              <div className="relative">
                <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={codeRef}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="6 位验证码"
                  aria-label="验证码"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, ''));
                    setError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  disabled={busy}
                  className="h-11 pl-9 font-mono tracking-[0.2em]"
                />
              </div>
              <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                <span>5 分钟内有效</span>
                {countdown > 0 ? (
                  <span>{countdown} 秒后可重新发送</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void sendCode()}
                    disabled={busy}
                    className="font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    重新发送
                  </button>
                )}
              </div>
            </div>
          )}

          {notice && !error && <p className="text-sm text-muted-foreground">{notice}</p>}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button className="h-11 w-full text-sm" onClick={submit} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 请稍候…
              </>
            ) : showCode ? (
              '验证并登录'
            ) : (
              '继续'
            )}
          </Button>
        </div>

        <div className="mt-6 space-y-1 text-center">
          <button
            type="button"
            onClick={onSkip}
            disabled={busy}
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            先跳过，不登录使用
          </button>
          <p className="text-xs text-muted-foreground">不登录也能对话、使用技能和连接器，只是不能生图、生视频和配音</p>
        </div>
      </Card>
    </main>
  );
}
