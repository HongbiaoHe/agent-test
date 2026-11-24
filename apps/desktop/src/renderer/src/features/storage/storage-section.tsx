/**
 * 设置 → 存储：当前账号的会话在本机占了多少。
 * 上方是合计与全局操作；下面两种看法——按会话（勾选后批量清缓存 / 删除）、按分类（缓存类可整类清空）。
 * 清缓存与删除都先确认；删除会话会把它新建的产出文件移到废纸篓（见 agent-host/storage/）。
 */
import { Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/components/attachments/attachments';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CACHE_CATEGORIES, SHARED_CACHE_CATEGORIES } from '../../../../shared/storage';
import { CategoryUsageList } from './components/category-usage-list';
import { ConversationUsageList } from './components/conversation-usage-list';
import { type ClearCacheInput, useStorage } from './use-storage';

/** 等用户确认的操作 */
type Pending =
  | { kind: 'delete'; ids: string[] }
  | { kind: 'clear'; input: ClearCacheInput; title: string; description: string };

export function StorageSection({ onConversationsDeleted }: { onConversationsDeleted?: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const { report, clearCache, deleteConversations } = useStorage((ids) => {
    setSelected(new Set());
    onConversationsDeleted?.(ids);
  });
  const data = report.data;
  const busy = clearCache.isPending || deleteConversations.isPending;

  // 扫描失败且手上没有上一次的结果：说明原因并给重试（有旧结果时照常显示，顶部「重新扫描」可再试）
  if (!data && report.isError) {
    return (
      <Alert variant="destructive" data-testid="storage-error">
        <AlertTitle>{t('settings.storage.scanFailed')}</AlertTitle>
        <AlertDescription>{report.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" disabled={report.isFetching} onClick={() => void report.refetch()}>
            {report.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t('common.retry')}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3" data-testid="storage-loading">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const sharedBytes = SHARED_CACHE_CATEGORIES.reduce((sum, k) => sum + data.shared[k].bytes, 0);
  const totalBytes = data.conversations.reduce((sum, c) => sum + c.totalBytes, 0) + sharedBytes;
  const cacheBytes = data.conversations.reduce((sum, c) => sum + c.cacheBytes, 0) + sharedBytes;
  // 扫描结果里已经没有的会话（刚被删）不算选中
  const alive = new Set(data.conversations.map((c) => c.id));
  const selectedAlive = new Set([...selected].filter((id) => alive.has(id)));

  const askClear = (input: ClearCacheInput, title: string = t('settings.storage.confirm.clearTitle')) =>
    setPending({ kind: 'clear', input, title, description: t('settings.storage.confirm.clearDescription') });
  const outputsOf = (ids: string[]) =>
    data.conversations
      .filter((c) => ids.includes(c.id))
      .reduce((sum, c) => ({ bytes: sum.bytes + c.usage.outputs.bytes, count: sum.count + c.usage.outputs.count }), {
        bytes: 0,
        count: 0,
      });
  const confirm = () => {
    if (!pending) return;
    const done = { onSettled: () => setPending(null) };
    if (pending.kind === 'delete') deleteConversations.mutate(pending.ids, done);
    else clearCache.mutate(pending.input, done);
  };
  const outputs = pending?.kind === 'delete' ? outputsOf(pending.ids) : null;

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <div className="text-xs text-muted-foreground">{t('settings.storage.total')}</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid="storage-total">
              {formatBytes(totalBytes)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t('settings.storage.cache')}</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid="storage-cache">
              {formatBytes(cacheBytes)}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={report.isFetching} onClick={() => void report.refetch()}>
              {report.isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t('settings.storage.rescan')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={cacheBytes === 0}
              onClick={() => askClear({ categories: [...CACHE_CATEGORIES], sharedCategories: [...SHARED_CACHE_CATEGORIES] })}
              data-testid="storage-clear-all"
            >
              {t('settings.storage.clearAllCache')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('settings.storage.conversations', { count: data.conversations.length })}
          {' · '}
          {t('settings.storage.database', { size: formatBytes(data.databaseBytes) })}
          {' · '}
          {t('settings.storage.webNote')}
        </p>
      </section>

      <Tabs defaultValue="conversations" className="flex-col gap-3">
        <TabsList>
          <TabsTrigger value="conversations">{t('settings.storage.tabs.conversations')}</TabsTrigger>
          <TabsTrigger value="categories">{t('settings.storage.tabs.categories')}</TabsTrigger>
        </TabsList>
        <TabsContent value="conversations">
          <ConversationUsageList
            conversations={data.conversations}
            selected={selectedAlive}
            onSelectedChange={setSelected}
            onClearCache={(ids) => askClear({ conversationIds: ids, categories: [...CACHE_CATEGORIES] })}
            onDelete={(ids) => setPending({ kind: 'delete', ids })}
          />
        </TabsContent>
        <TabsContent value="categories">
          <CategoryUsageList
            report={data}
            onClearCategory={(k) =>
              askClear(
                { categories: [k] },
                t('settings.storage.confirm.clearCategoryTitle', { name: t(`settings.storage.categories.${k}.label`) }),
              )
            }
            onClearShared={(k) =>
              setPending({
                kind: 'clear',
                input: { categories: [], sharedCategories: [k] },
                title: t('settings.storage.confirm.clearCategoryTitle', {
                  name: t(`settings.storage.categories.${k}.label`),
                }),
                description: t('settings.storage.confirm.clearSharedDescription'),
              })
            }
          />
        </TabsContent>
      </Tabs>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && !busy && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'delete'
                ? t('settings.storage.confirm.deleteTitle', { count: pending.ids.length })
                : pending?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'delete' ? t('settings.storage.confirm.deleteDescription') : pending?.description}
              {outputs && outputs.count > 0 && (
                <span className="mt-2 block" data-testid="storage-confirm-outputs">
                  {t('settings.storage.confirm.deleteOutputs', { count: outputs.count, size: formatBytes(outputs.bytes) })}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant={pending?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={busy}
              onClick={confirm}
              data-testid="storage-confirm"
            >
              {busy ? (
                <Loader2 className="animate-spin" />
              ) : pending?.kind === 'delete' ? (
                t('common.delete')
              ) : (
                t('settings.storage.actions.clear')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
