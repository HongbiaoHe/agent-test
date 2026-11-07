import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { listPromptFragments, PROMPT_FRAGMENTS_KEY, type PromptFragmentView } from '@/lib/api';
import { FragmentEditor } from './fragment-editor';

/** 正文第一个非空行（列表里当摘要） */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? '';
}

/**
 * 平台片段：内置 4 个 {{platform.xxx}}，每行 id + 正文首行 + 「已自定义」+ 编辑。不能新增片段。
 */
export function PromptFragments() {
  const { t } = useTranslation();
  const headingId = useId();
  const [editing, setEditing] = useState<PromptFragmentView | null>(null);
  const query = useQuery({ queryKey: PROMPT_FRAGMENTS_KEY, queryFn: listPromptFragments });

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t('settings.modes.fragments.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('settings.modes.fragments.description')}</p>
      </div>
      {query.isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : query.isError || !query.data ? (
        <p className="text-sm text-destructive" role="alert">
          {query.error instanceof Error ? query.error.message : t('settings.modes.fragments.loadFailed')}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {query.data.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="font-mono text-sm">{f.id}</code>
                  {f.isCustom && <Badge variant="outline">{t('settings.modes.fragments.custom')}</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{firstLine(f.text)}</p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('settings.modes.fragments.edit', { id: f.id })}
                      onClick={() => setEditing(f)}
                    />
                  }
                >
                  <Pencil />
                </TooltipTrigger>
                <TooltipContent>{t('common.edit')}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <FragmentEditor fragment={editing} onClose={() => setEditing(null)} />
    </section>
  );
}
