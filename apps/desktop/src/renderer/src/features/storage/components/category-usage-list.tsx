/**
 * 按分类看占用：每个分类一行（合计 / 条目数 / 是缓存还是数据），点开看哪些会话占了这一类；
 * 缓存类可以整类清空。最下面是不属于单个会话的共享缓存。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/components/attachments/attachments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExpandToggle } from './expand-toggle';
import {
  type CacheCategory,
  isCacheCategory,
  SHARED_CACHE_CATEGORIES,
  type SharedCacheCategory,
  STORAGE_CATEGORIES,
  type StorageCategory,
  type StorageReport,
} from '../../../../../shared/storage';

export function CategoryUsageList({
  report,
  onClearCategory,
  onClearShared,
}: {
  report: StorageReport;
  onClearCategory: (category: CacheCategory) => void;
  onClearShared: (category: SharedCacheCategory) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<StorageCategory | null>(null);
  const totalOf = (k: StorageCategory) =>
    report.conversations.reduce(
      (sum, c) => ({ bytes: sum.bytes + c.usage[k].bytes, count: sum.count + c.usage[k].count }),
      { bytes: 0, count: 0 },
    );

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {STORAGE_CATEGORIES.map((k) => {
          const total = totalOf(k);
          const open = expanded === k;
          const users = report.conversations.filter((c) => c.usage[k].bytes > 0).sort((a, b) => b.usage[k].bytes - a.usage[k].bytes);
          return (
            <li key={k} data-testid={`storage-category-${k}`}>
              <div className="flex items-center gap-3 px-3 py-2.5">
                <ExpandToggle open={open} onToggle={() => setExpanded(open ? null : k)} align="start">
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex items-center gap-2 text-sm">
                      {t(`settings.storage.categories.${k}.label`)}
                      <Badge variant={isCacheCategory(k) ? 'outline' : 'secondary'}>
                        {t(`settings.storage.kind.${isCacheCategory(k) ? 'cache' : 'data'}`)}
                      </Badge>
                    </span>
                    <span className="block text-xs text-muted-foreground">{t(`settings.storage.categories.${k}.hint`)}</span>
                  </span>
                </ExpandToggle>
                <div className="w-24 shrink-0 text-right">
                  <div className="text-sm tabular-nums">{formatBytes(total.bytes)}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {t('settings.storage.items', { count: total.count })}
                  </div>
                </div>
                <div className="w-16 shrink-0 text-right">
                  {isCacheCategory(k) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={total.bytes === 0}
                      onClick={() => onClearCategory(k)}
                      data-testid={`storage-clear-${k}`}
                    >
                      {t('settings.storage.actions.clear')}
                    </Button>
                  )}
                </div>
              </div>
              {open && (
                <ul className="space-y-1 border-t border-border bg-muted/40 px-3 py-2 pl-9 text-xs">
                  {users.length === 0 && <li className="text-muted-foreground">{t('settings.storage.noUsage')}</li>}
                  {users.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3">
                      <span className="truncate">{c.title || c.goal || t('settings.storage.untitled')}</span>
                      <span className="shrink-0 tabular-nums">{formatBytes(c.usage[k].bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('settings.storage.shared')}</h3>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {SHARED_CACHE_CATEGORIES.map((k) => (
            <li key={k} className="flex items-center gap-3 px-3 py-2.5" data-testid={`storage-shared-${k}`}>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm">{t(`settings.storage.categories.${k}.label`)}</div>
                <div className="text-xs text-muted-foreground">{t(`settings.storage.categories.${k}.hint`)}</div>
              </div>
              <div className="w-24 shrink-0 text-right">
                <div className="text-sm tabular-nums">{formatBytes(report.shared[k].bytes)}</div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {t('settings.storage.items', { count: report.shared[k].count })}
                </div>
              </div>
              <div className="w-16 shrink-0 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={report.shared[k].bytes === 0}
                  onClick={() => onClearShared(k)}
                  data-testid={`storage-clear-${k}`}
                >
                  {t('settings.storage.actions.clear')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
