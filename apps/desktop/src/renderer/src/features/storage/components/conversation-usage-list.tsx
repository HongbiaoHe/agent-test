/**
 * 按会话看占用：每行一个会话（勾选 / 总占用 / 其中缓存 / 占用条），点开看六个分类的明细；
 * 行尾菜单可单独清缓存或删除，勾选后用上方工具条批量操作。
 */
import { Eraser, MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/components/attachments/attachments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type ConversationStorage, isCacheCategory, STORAGE_CATEGORIES } from '../../../../../shared/storage';
import { ExpandToggle } from './expand-toggle';
import { UsageBar } from './usage-bar';

export function ConversationUsageList({
  conversations,
  selected,
  onSelectedChange,
  onClearCache,
  onDelete,
}: {
  conversations: ConversationStorage[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onClearCache: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxBytes = conversations.reduce((m, c) => Math.max(m, c.totalBytes), 0);
  const allSelected = conversations.length > 0 && conversations.every((c) => selected.has(c.id));
  const ids = [...selected];
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };

  if (conversations.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('settings.storage.empty')}</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex h-8 items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && selected.size > 0}
            onCheckedChange={(on) => onSelectedChange(on ? new Set(conversations.map((c) => c.id)) : new Set())}
            data-testid="storage-select-all"
          />
          {selected.size > 0 ? t('settings.storage.selected', { count: selected.size }) : t('settings.storage.selectAll')}
        </label>
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onClearCache(ids)} data-testid="storage-clear-selected">
              <Eraser />
              {t('settings.storage.clearSelected')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onDelete(ids)} data-testid="storage-delete-selected">
              <Trash2 />
              {t('settings.storage.deleteSelected')}
            </Button>
          </div>
        )}
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {conversations.map((c) => {
          const title = c.title || c.goal || t('settings.storage.untitled');
          const open = expanded === c.id;
          return (
            <li key={c.id} data-testid={`storage-row-${c.id}`}>
              <div className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  checked={selected.has(c.id)}
                  onCheckedChange={(on) => toggle(c.id, on)}
                  aria-label={t('settings.storage.selectOne', { title })}
                />
                <ExpandToggle open={open} onToggle={() => setExpanded(open ? null : c.id)}>
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm">{title}</span>
                      {c.busy && <Badge variant="secondary">{t('settings.storage.busy')}</Badge>}
                    </span>
                    <UsageBar totalBytes={c.totalBytes} cacheBytes={c.cacheBytes} maxBytes={maxBytes} />
                  </span>
                </ExpandToggle>
                <div className="w-28 shrink-0 text-right">
                  <div className="text-sm tabular-nums" data-testid="storage-usage-total">
                    {formatBytes(c.totalBytes)}
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {t('settings.storage.cacheOf', { size: formatBytes(c.cacheBytes) })}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={t('settings.storage.actions.more')} />}
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem disabled={c.busy || c.cacheBytes === 0} onClick={() => onClearCache([c.id])}>
                      <Eraser />
                      {t('settings.storage.actions.clearCache')}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete([c.id])}>
                      <Trash2 />
                      {t('settings.storage.actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {open && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-border bg-muted/40 px-3 py-2 pl-12 text-xs">
                  {STORAGE_CATEGORIES.map((k) => (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1.5 text-muted-foreground">
                        {t(`settings.storage.categories.${k}.label`)}
                        {isCacheCategory(k) && <Badge variant="outline">{t('settings.storage.kind.cache')}</Badge>}
                      </dt>
                      <dd className="tabular-nums">
                        {formatBytes(c.usage[k].bytes)}
                        <span className="ml-1.5 text-muted-foreground">
                          {t('settings.storage.items', { count: c.usage[k].count })}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
