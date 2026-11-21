/**
 * 画布列表（侧栏「画布」）：Web 账号下的全部画布（与网页端同一批），可新建；点开进画布视图，
 * 右侧对话栏显示最近一个绑定着这块画布的本地对话（没有就空着，发第一条消息时才新建）。
 * 没登录 Web 账号时引导登录。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, Network, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { agent } from '@/lib/agent-client';
import { cn } from '@/lib/utils';
import { useWebAccount } from '../auth/use-web-account';
import { CANVAS_LIST_KEY } from './lib/query-keys';
import type { CanvasTarget } from './open-canvas-context';

export function CanvasListView({
  headerInset,
  onOpen,
  onSignIn,
}: {
  headerInset?: string;
  onOpen: (target: CanvasTarget) => void;
  onSignIn: () => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const account = useWebAccount();
  const signedIn = account.data?.signedIn ?? false;
  const list = useQuery({
    queryKey: CANVAS_LIST_KEY,
    queryFn: () => agent.call('canvas.list', {}),
    enabled: signedIn,
  });
  /** 打开：右侧对话栏接上最近一个绑定着它的对话 */
  const open = async (canvasId: string) => {
    const conv = await agent.call('canvas.latestConversation', { id: canvasId });
    onOpen({ canvasId, conversationId: conv?.id ?? null });
  };
  const create = useMutation({
    mutationFn: () => agent.call('canvas.create', {}),
    onSuccess: ({ sessionId }) => {
      void qc.invalidateQueries({ queryKey: CANVAS_LIST_KEY });
      onOpen({ canvasId: sessionId, conversationId: null });
    },
    onError: (e) => toast.error(e.message),
  });
  const dateFmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex h-full flex-col" data-testid="canvas-list-view">
      <header className={cn('app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border px-4', headerInset)}>
        <h1 className="text-sm font-medium">{t('canvas.list.title')}</h1>
        <div className="flex-1" />
        {signedIn && (
          <Button size="sm" className="app-no-drag" onClick={() => create.mutate()} disabled={create.isPending}>
            <Plus data-icon="inline-start" />
            {create.isPending ? t('canvas.list.creating') : t('canvas.list.create')}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
          {!signedIn ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Network className="size-8 text-muted-foreground" />
              <h2 className="text-base font-medium">{t('canvas.list.signInTitle')}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">{t('canvas.list.signInDescription')}</p>
              <Button onClick={onSignIn}>
                <LogIn data-icon="inline-start" />
                {t('canvas.list.signIn')}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('canvas.list.description')}</p>
              {list.isError && (
                <p className="text-sm text-destructive" role="alert">
                  {t('canvas.list.loadFailed', { message: list.error.message })}
                </p>
              )}
              {list.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full rounded-lg" />
                  ))}
                </div>
              ) : list.data && list.data.items.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
                  <p className="text-sm font-medium">{t('canvas.list.empty')}</p>
                  <p className="max-w-sm text-sm text-muted-foreground">{t('canvas.list.emptyHint')}</p>
                </div>
              ) : (
                <ul className="space-y-2" aria-label={t('canvas.list.title')}>
                  {list.data?.items.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        data-testid="canvas-list-item"
                        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
                        onClick={() => void open(c.id).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))}
                      >
                        <Network className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.title || t('canvas.list.untitled')}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {t('canvas.list.updatedAt', { time: dateFmt.format(new Date(c.updatedAt)) })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
