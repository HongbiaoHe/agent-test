/**
 * 会话的置顶 / 重命名 / 删除（侧栏条目菜单与对话顶栏标题菜单共用）。
 * 成功后刷新侧栏列表；删除成功回调 onDeleted（调用方决定是否回首页）。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { agent } from '@/lib/agent-client';

export function useConversationActions(onDeleted?: (id: string) => void) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['conversations'] });
  const onError = (e: Error) => toast.error(e.message);

  const setPinned = useMutation({
    mutationFn: (p: { id: string; pinned: boolean }) => agent.call('conversations.update', p),
    onSuccess: refresh,
    onError,
  });
  const rename = useMutation({
    mutationFn: (p: { id: string; title: string }) => agent.call('conversations.update', p),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => agent.call('conversations.delete', { id }),
    onSuccess: (_r, id) => {
      refresh();
      onDeleted?.(id);
    },
    onError,
  });
  return { setPinned, rename, remove };
}
