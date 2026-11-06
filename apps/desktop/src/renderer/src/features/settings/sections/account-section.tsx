/**
 * 设置 → 账号：Web 账号（登录后经 Web 后端用生图 / 生视频 / 配音）与 Web 后端地址。
 * 登录本身在登录页完成（只要邮箱 + 验证码）；这里看状态、退出、改地址。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { currentLocale } from '@/lib/i18n';
import { useWebAccount, WEB_ACCOUNT_KEY } from '../../auth/use-web-account';
import { useSettings } from './use-settings';

export function AccountSection({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useTranslation();
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
      toast.success(t('settings.account.signedOutToast'));
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
    toast.success(t('settings.account.apiUrlUpdated'));
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {t('settings.account.title')}
          {s?.signedIn ? (
            <Badge variant="secondary">{t('settings.account.signedIn')}</Badge>
          ) : (
            <Badge variant="outline">{t('settings.account.signedOut')}</Badge>
          )}
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
                  {t('settings.account.expiresAt', {
                    date: s.expiresAt ? new Date(s.expiresAt).toLocaleString(currentLocale()) : '—',
                  })}
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              <LogOut data-icon="inline-start" />
              {t('settings.account.signOut')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <p className="text-sm text-muted-foreground">{t('settings.account.signedOutHint')}</p>
            <Button className="shrink-0" onClick={onSignIn}>
              <LogIn data-icon="inline-start" />
              {t('settings.account.signIn')}
            </Button>
          </div>
        )}
      </section>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('settings.account.apiUrl')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.account.apiUrlHint')}</p>
        <div className="flex gap-2">
          <Input
            aria-label={t('settings.account.apiUrl')}
            className="font-mono"
            value={draftUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveUrl();
            }}
          />
          <Button variant="outline" disabled={!draftUrl.trim() || draftUrl.trim() === currentUrl} onClick={() => void saveUrl()}>
            {t('common.save')}
          </Button>
        </div>
      </section>
    </div>
  );
}
