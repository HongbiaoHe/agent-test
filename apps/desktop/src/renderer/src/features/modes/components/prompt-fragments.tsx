import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  deletePromptFragment,
  listPromptFragments,
  MODE_CATALOG_KEY,
  PROMPT_FRAGMENTS_KEY,
  type PromptFragmentView,
} from '@/lib/api';
import { FragmentEditor, type FragmentEditorTarget } from './fragment-editor';

type CustomFragment = Extract<PromptFragmentView, { kind: 'custom' }>;

/** 正文第一个非空行（列表里当摘要） */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '') ?? '';
}

/**
 * 平台片段：内置 4 个 {{platform.xxx}}（id + 正文首行 + 「已自定义」+ 编辑），其后是用户自建的 {{custom.xxx}}
 * （显示名 + id + 正文首行 + 编辑 / 删除）；右上角新建片段。
 */
export function PromptFragments() {
  const { t } = useTranslation();
  const headingId = useId();
  const [editing, setEditing] = useState<FragmentEditorTarget | null>(null);
  const [deleting, setDeleting] = useState<CustomFragment | null>(null);
  const query = useQuery({ queryKey: PROMPT_FRAGMENTS_KEY, queryFn: listPromptFragments });

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 id={headingId} className="text-sm font-semibold">
            {t('settings.modes.fragments.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('settings.modes.fragments.description')}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing({ kind: 'create' })}>
          <Plus /> {t('settings.modes.fragments.newFragment')}
        </Button>
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
                {f.kind === 'builtin' ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono text-sm">{f.id}</code>
                    {f.isCustom && <Badge variant="outline">{t('settings.modes.fragments.custom')}</Badge>}
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium">{f.title}</span>
                    <code className="font-mono text-xs text-muted-foreground">{f.id}</code>
                  </div>
                )}
                <p className="truncate text-xs text-muted-foreground">{firstLine(f.text)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('settings.modes.fragments.edit', { id: f.id })}
                        onClick={() => setEditing({ kind: 'edit', fragment: f })}
                      />
                    }
                  >
                    <Pencil />
                  </TooltipTrigger>
                  <TooltipContent>{t('common.edit')}</TooltipContent>
                </Tooltip>
                {f.kind === 'custom' && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('settings.modes.fragments.delete', { id: f.id })}
                          onClick={() => setDeleting(f)}
                        />
                      }
                    >
                      <Trash2 />
                    </TooltipTrigger>
                    <TooltipContent>{t('common.delete')}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <FragmentEditor target={editing} onClose={() => setEditing(null)} />
      <DeleteFragmentDialog fragment={deleting} onClose={() => setDeleting(null)} />
    </section>
  );
}

/** 删除确认：仍被模式 / 通用提示词引用时 host 拒绝，报错（含引用处）留在弹窗里 */
function DeleteFragmentDialog({ fragment, onClose }: { fragment: CustomFragment | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => deletePromptFragment(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROMPT_FRAGMENTS_KEY });
      void qc.invalidateQueries({ queryKey: MODE_CATALOG_KEY });
      onClose();
    },
  });

  return (
    <AlertDialog
      open={fragment !== null}
      onOpenChange={(open) => {
        if (open) return;
        del.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.modes.fragments.deleteTitle', { title: fragment?.title ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>{t('settings.modes.fragments.deleteDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        {del.isError && (
          <p className="text-sm text-destructive" role="alert">
            {del.error instanceof Error ? del.error.message : t('settings.modes.fragments.deleteFailed')}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>{t('common.cancel')}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() => {
              if (fragment) del.mutate(fragment.id);
            }}
          >
            {del.isPending ? <Loader2 className="animate-spin" /> : t('common.delete')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
