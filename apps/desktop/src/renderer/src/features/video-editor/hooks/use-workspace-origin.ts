/** 工作区的 spark-preview:// 源（同预览弹窗的查询键，缓存共用） */
import { useQuery } from '@tanstack/react-query';

export function useWorkspaceOrigin(workspaceDir: string | null): string | null {
  const q = useQuery({
    queryKey: ['site-preview-origin', workspaceDir],
    queryFn: () => window.desktop.sitePreviewOrigin(workspaceDir ?? ''),
    enabled: workspaceDir !== null,
    staleTime: Infinity,
    retry: false,
  });
  return q.data ?? null;
}
