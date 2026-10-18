"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { Loader2, Pencil, Pin, PinOff, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  createCanvas,
  listCanvases,
  renameCanvas,
  type CanvasListItem,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  CANVAS_STATUS_DOT,
  CANVAS_STATUS_DOT_FALLBACK,
} from "../_lib/canvas-status";
import { useCanvasPin } from "../_hooks/use-canvas-pin";

/** 分页缓存结构（useInfiniteQuery pages）：与 listCanvases 返回一致 */
type CanvasPage = { items: CanvasListItem[]; nextCursor: string | null };

export function CanvasSidebar({
  activeId,
  onNavigate,
}: {
  activeId: string | null;
  /** 跳到某块画布后的回调：手机上侧栏在底部抽屉里，跳完要把抽屉关掉 */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const go = (id: string) => {
    router.push(`/canvas/${id}`);
    onNavigate?.();
  };
  const qc = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ["canvas-list"],
    queryFn: ({ pageParam }) => listCanvases(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: CanvasPage) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  // 滚动加载哨兵：列表底部进入视口即拉下一页
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const ob = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    ob.observe(el);
    return () => ob.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const createMut = useMutation({
    mutationFn: () => createCanvas({}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["canvas-list"] });
      go(r.sessionId);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameCanvas(id, title),
    // 乐观更新：立即改分页缓存（pages[].items[]），失败回滚
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: ["canvas-list"] });
      const prev = qc.getQueryData<InfiniteData<CanvasPage>>(["canvas-list"]);
      qc.setQueryData<InfiniteData<CanvasPage>>(["canvas-list"], (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((c) =>
                  c.id === id ? { ...c, title } : c,
                ),
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

  const pinMut = useCanvasPin();

  // 内联重命名的本地态；finishRef 防止 Esc/Enter 与随后的 blur 重复触发
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const finishRef = useRef(false);

  function startEdit(c: CanvasListItem) {
    finishRef.current = false;
    setEditingId(c.id);
    setDraft(c.title);
  }
  function commit() {
    if (finishRef.current) return;
    finishRef.current = true;
    const id = editingId;
    const t = draft.trim();
    const cur = items.find((c) => c.id === id)?.title;
    if (id && t && t !== cur) renameMut.mutate({ id, title: t });
    setEditingId(null);
  }
  function cancel() {
    if (finishRef.current) return;
    finishRef.current = true;
    setEditingId(null);
  }

  // 宽度、底色与标题栏都由外层容器给（桌面=FloatingPanel，手机=底部抽屉），
  // 这里只负责列表本身，同一份内容才能塞进两种外壳
  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="px-3 pt-3">
        <Button
          className="w-full"
          size="sm"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
        >
          <Plus className="size-4" /> New canvas
        </Button>
      </div>
      {/* min-h-0：flex 子项默认 min-height:auto 会被内容撑开（不可滚），必须显式允许收缩 */}
      <ScrollArea className="mt-2 min-h-0 flex-1 px-2">
        <div className="flex flex-col gap-0.5 py-1">
          {items.map((c) => {
            const dot = (
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  CANVAS_STATUS_DOT[c.status] ?? CANVAS_STATUS_DOT_FALLBACK,
                )}
              />
            );
            if (c.id === editingId) {
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-md bg-accent px-2.5 py-1.5"
                >
                  {dot}
                  <Input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      else if (e.key === "Escape") cancel();
                    }}
                    className="h-6 flex-1 px-2 py-0 text-sm"
                  />
                </div>
              );
            }
            return (
              <div key={c.id} className="group relative">
                <button
                  onClick={() => go(c.id)}
                  onDoubleClick={() => startEdit(c)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md py-2 pl-2.5 pr-14 text-left text-sm transition-colors hover:bg-accent",
                    c.id === activeId && "bg-accent",
                  )}
                >
                  {dot}
                  {c.pinnedAt && (
                    <Pin
                      aria-label="Pinned"
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="truncate">{c.title}</span>
                </button>
                {/* 行内操作（置顶 / 重命名）：悬停或键盘聚焦时出现，触屏常显 */}
                <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100">
                  <button
                    onClick={() =>
                      pinMut.mutate({ id: c.id, pinned: !c.pinnedAt })
                    }
                    // 带上画布名：所在浮动面板的标题栏还有个「Pin panel」，读屏要能区分
                    aria-label={`${c.pinnedAt ? "Unpin" : "Pin"} ${c.title}`}
                    title={c.pinnedAt ? "Unpin" : "Pin"}
                    className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    {c.pinnedAt ? (
                      <PinOff className="size-3.5" />
                    ) : (
                      <Pin className="size-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => startEdit(c)}
                    aria-label={`Rename ${c.title}`}
                    title="Rename"
                    className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {!list.isLoading && items.length === 0 && (
            <p className="px-2.5 py-4 text-xs text-muted-foreground">
              No canvases yet. Create one above.
            </p>
          )}
          {/* 滚动加载哨兵：进入视口即拉下一页；加载中转圈 */}
          {hasNextPage && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-2"
            >
              {isFetchingNextPage && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
