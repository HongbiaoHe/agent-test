/**
 * 设置 → 账号：Web 账号（登录后经 Web 后端用生图 / 生视频 / 配音）与 Web 后端地址。
 * 登录本身在登录页完成（只要邮箱 + 验证码）；这里看状态、退出、改地址。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useWebAccount, WEB_ACCOUNT_KEY } from '../../auth/use-web-account';
import { useSettings } from './use-settings';

export function AccountSection({ onSignIn }: { onSignIn: () => void }) {
  const qc = useQueryClient();
  const account = useWebAccount();
  const { settings, update } = useSettings();
  const [apiUrl, setApiUrl] = useState<string | null>(null);
  const s = account.data;
  const currentUrl = settings.data?.webApiUrl ?? '';
  const draftUrl = apiUrl ?? currentUrl;

  const signOut = useMutation({
    mutationFn: () => window.desktop.signOutWeb(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: WEB_ACCOUNT_KEY });
      toast.success('已退出 Web 账号');
    },
    onError: (e) => toast.error(e.message),
  });

  async function saveUrl() {
    const next = draftUrl.trim().replace(/\/+$/, '');
    if (!next || next === currentUrl) return;
    // 令牌和后端地址绑定：换地址就退出当前账号，再到登录页重新登录
    if (s?.signedIn) await window.desktop.signOutWeb();
    update.mutate({ webApiUrl: next });
    setApiUrl(null);
    void qc.invalidateQueries({ queryKey: WEB_ACCOUNT_KEY });
    toast.success('Web 后端地址已更新');
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          Web 账号
          {s?.signedIn ? <Badge variant="secondary">已登录</Badge> : <Badge variant="outline">未登录</Badge>}
        </h3>
        {s?.signedIn ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar>
                <AvatarFallback>{(s.email ?? 'U').charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 text-sm">
                <div className="truncate font-medium" data-testid="web-account-email">
                  {s.email}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  有效期至 {s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '—'}
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              <LogOut data-icon="inline-start" />
              退出登录
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <p className="text-sm text-muted-foreground">没有登录：对话、技能、连接器照常可用，生图、生视频、配音需要登录。</p>
            <Button className="shrink-0" onClick={onSignIn}>
              <LogIn data-icon="inline-start" />
              登录
            </Button>
          </div>
        )}
      </section>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Web 后端地址</h3>
        <p className="text-xs text-muted-foreground">
          生成请求发往这个地址（本机开发是 http://localhost:3101）。登录状态和地址绑定，更换地址会退出当前账号。
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="Web 后端地址"
            className="font-mono"
            value={draftUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveUrl();
            }}
          />
          <Button variant="outline" disabled={!draftUrl.trim() || draftUrl.trim() === currentUrl} onClick={() => void saveUrl()}>
            保存
          </Button>
        </div>
      </section>
    </div>
  );
}
