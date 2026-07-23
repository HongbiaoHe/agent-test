"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, LayoutGrid, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

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

export function CanvasSidebar({ activeId }: { activeId: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["canvas-list"], queryFn: listCanvases });

  const createMut = useMutation({
    mutationFn: () => createCanvas({}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["canvas-list"] });
      router.push(`/canvas/${r.sessionId}`);
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      renameCanvas(id, title),
    // 乐观更新：立即改列表缓存，失败回滚
    onMutate: async ({ id, title }) => {
      await qc.cancelQueries({ queryKey: ["canvas-list"] });
      const prev = qc.getQueryData<CanvasListItem[]>(["canvas-list"]);
      qc.setQueryData<CanvasListItem[]>(["canvas-list"], (old) =>
        old?.map((c) => (c.id === id ? { ...c, title } : c)),
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
    const cur = list.data?.find((c) => c.id === id)?.title;
    if (id && t && t !== cur) renameMut.mutate({ id, title: t });
    setEditingId(null);
  }
  function cancel() {
    if (finishRef.current) return;
    finishRef.current = true;
    setEditingId(null);
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <LayoutGrid className="size-4" /> 画布工作流
        </span>
      </div>
      <div className="px-3">
        <Button
          className="w-full"
          size="sm"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
        >
          <Plus className="size-4" /> 新建画布
        </Button>
      </div>
      <ScrollArea className="mt-2 flex-1 px-2">
        <div className="flex flex-col gap-0.5 py-1">
          {list.data?.map((c) => {
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
                  onClick={() => router.push(`/canvas/${c.id}`)}
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
                  aria-label="重命名"
                  title="重命名"
                  className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </button>
              </div>
            );
          })}
          {list.data?.length === 0 && (
            <p className="px-2.5 py-4 text-xs text-muted-foreground">
              还没有画布，点上方新建。
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
