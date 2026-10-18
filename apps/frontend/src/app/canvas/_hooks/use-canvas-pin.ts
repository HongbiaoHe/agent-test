"use client";

import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import { setCanvasPinned, type CanvasListItem } from "@/lib/api";

type CanvasPage = { items: CanvasListItem[]; nextCursor: string | null };

/**
 * 画布置顶 / 取消置顶（列表页与画布内侧栏共用，二者读同一个 ["canvas-list"] 分页缓存）。
 * 乐观改图钉状态；顺序由服务端决定（置顶在前），onSettled 重拉后行才挪位置。
 */
export function useCanvasPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      setCanvasPinned(id, pinned),
    onMutate: async ({ id, pinned }) => {
      await qc.cancelQueries({ queryKey: ["canvas-list"] });
      const prev = qc.getQueryData<InfiniteData<CanvasPage>>(["canvas-list"]);
      const pinnedAt = pinned ? new Date().toISOString() : null;
      qc.setQueryData<InfiniteData<CanvasPage>>(["canvas-list"], (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((c) => (c.id === id ? { ...c, pinnedAt } : c)),
              })),
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["canvas-list"], ctx.prev);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["canvas-list"] }),
  });
}
