/**
 * 设置 → 存储 的数据：扫描结果 + 清缓存 / 删会话。操作完重新扫描，并刷新侧栏会话列表。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { formatBytes } from '@/components/attachments/attachments';
import { agent } from '@/lib/agent-client';
import type { CacheCategory, SharedCacheCategory } from '../../../../shared/storage';

export const STORAGE_KEY = ['storage'] as const;

export interface ClearCacheInput {
  /** 不给 = 全部会话 */
  conversationIds?: string[];
  categories: CacheCategory[];
  sharedCategories?: SharedCacheCategory[];
}

export function useStorage(onDeleted?: (ids: string[]) => void) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: STORAGE_KEY, queryFn: () => agent.call('storage.scan', {}) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: STORAGE_KEY });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
  // 出错时可能已经做了一部分（批量删除里先删掉的那些）：照样重新扫描
  const onError = (e: Error) => {
    toast.error(e.message);
    refresh();
  };

  const clearCache = useMutation({
    mutationFn: (input: ClearCacheInput) => agent.call('storage.clearCache', input),
    onSuccess: (res) => {
      toast.success(t('settings.storage.toast.freed', { size: formatBytes(res.freedBytes) }));
      if (res.skipped.length) toast.info(t('settings.storage.toast.skipped', { count: res.skipped.length }));
      refresh();
    },
    onError,
  });

  const deleteConversations = useMutation({
    mutationFn: (ids: string[]) => agent.call('storage.deleteConversations', { ids }),
    onSuccess: (res) => {
      toast.success(t('settings.storage.toast.deleted', { count: res.deleted.length }));
      if (res.trashedFiles) toast.info(t('settings.storage.toast.trashed', { count: res.trashedFiles }));
      if (res.failedFiles.length) toast.error(t('settings.storage.toast.trashFailed', { count: res.failedFiles.length }));
      refresh();
      onDeleted?.(res.deleted);
    },
    onError,
  });

  return { report, clearCache, deleteConversations };
}
