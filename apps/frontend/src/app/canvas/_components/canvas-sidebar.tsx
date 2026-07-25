"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { Loader2, Plus, LayoutGrid, Pencil } from "lucide-react";
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

const STATUS_DOT: Record<string, string> = {
  running: "bg-primary animate-pulse",
  queued: "bg-primary/60",
  waiting_approval: "bg-amber-500",
  done: "bg-muted-foreground/40",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/40",
  idle: "bg-muted-foreground/30",
};

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

  // max-md:w-full：手机上它装在底部抽屉里，撑满抽屉宽度而不是留一截空白
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card max-md:w-full max-md:border-r-0">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <LayoutGrid className="size-4" /> Canvas workflow
        </span>
      </div>
      <div className="px-3">
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
                  STATUS_DOT[c.status] ?? "bg-muted-foreground/30",
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
                    "flex w-full items-center gap-2 rounded-md py-2 pl-2.5 pr-8 text-left text-sm transition-colors hover:bg-accent",
                    c.id === activeId && "bg-accent",
                  )}
                >
                  {dot}
                  <span className="truncate">{c.title}</span>
                </button>
                <button
                  onClick={() => startEdit(c)}
                  aria-label="Rename"
                  title="Rename"
                  className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </button>
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
    </aside>
  );
}
