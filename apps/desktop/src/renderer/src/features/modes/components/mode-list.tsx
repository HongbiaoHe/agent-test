import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type AgentMode,
  deleteMode,
  GENERAL_MODE_KEY,
  type GeneralModeView,
  getGeneralMode,
  listModes,
  MODES_QUERY_KEY,
} from '@/lib/api';
import { modelDisplayName } from '../../chat/lib/models';

/**
 * 模式列表：最上方固定「通用」卡片（只能编辑，不能删除），下面是用户模式：名称 + 工具 / 连接器 / 技能计数 +
 * 默认模型；编辑 / 删除（确认后使用它的会话回到通用）
 */
export function ModeList({
  onEdit,
  onEditGeneral,
}: {
  onEdit: (mode: AgentMode) => void;
  onEditGeneral: (general: GeneralModeView) => void;
}) {
  return (
    <div className="space-y-3">
      <GeneralModeCard onEdit={onEditGeneral} />
      <UserModes onEdit={onEdit} />
    </div>
  );
}

function GeneralModeCard({ onEdit }: { onEdit: (general: GeneralModeView) => void }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: GENERAL_MODE_KEY, queryFn: getGeneralMode });
  if (query.isLoading) return <Skeleton className="h-16 w-full rounded-xl" />;
  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent className="py-4 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : t('settings.modes.list.loadFailed')}
        </CardContent>
      </Card>
    );
  }
  const g = query.data;
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{t('settings.modes.general')}</span>
            <Badge variant="secondary">{t('settings.modes.list.generalDefault')}</Badge>
            {g.isCustom && <Badge variant="outline">{t('settings.modes.list.generalCustom')}</Badge>}
            {g.defaultModel && (
              <Badge variant="outline">
                {t('settings.modes.list.defaultModel', { model: modelDisplayName(g.defaultModel) })}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.modes.list.generalDescription')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={t('common.edit')} onClick={() => onEdit(g)} />}
            >
              <Pencil />
            </TooltipTrigger>
            <TooltipContent>{t('common.edit')}</TooltipContent>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  );
}

function UserModes({ onEdit }: { onEdit: (mode: AgentMode) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<AgentMode | null>(null);
  const query = useQuery({ queryKey: MODES_QUERY_KEY, queryFn: listModes });
  const del = useMutation({
    mutationFn: (id: string) => deleteMode(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MODES_QUERY_KEY });
      // 引用它的会话 modeId 已置空
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      setDeleting(null);
    },
    onError: (e) => toast.error(e.message),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : t('settings.modes.list.loadFailed')}
        </CardContent>
      </Card>
    );
  }
  const modes = query.data ?? [];
  if (modes.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <SlidersHorizontal className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('settings.modes.list.empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {modes.map((m) => (
        <Card key={m.id}>
          <CardContent className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="truncate text-sm font-semibold">{m.name}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{t('settings.modes.list.tools', { count: m.toolNames.length })}</Badge>
                <Badge variant="secondary">{t('settings.modes.list.servers', { count: m.mcpServerIds.length })}</Badge>
                <Badge variant="secondary">{t('settings.modes.list.skills', { count: m.skillNames.length })}</Badge>
                {m.defaultModel && (
                  <Badge variant="outline">
                    {t('settings.modes.list.defaultModel', { model: modelDisplayName(m.defaultModel) })}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label={t('common.edit')} onClick={() => onEdit(m)} />}
                >
                  <Pencil />
                </TooltipTrigger>
                <TooltipContent>{t('common.edit')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label={t('common.delete')} onClick={() => setDeleting(m)} />
                  }
                >
                  <Trash2 />
                </TooltipTrigger>
                <TooltipContent>{t('common.delete')}</TooltipContent>
              </Tooltip>
            </div>
          </CardContent>
        </Card>
      ))}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.modes.list.deleteTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.modes.list.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                if (deleting) del.mutate(deleting.id);
              }}
            >
              {del.isPending ? <Loader2 className="animate-spin" /> : t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
