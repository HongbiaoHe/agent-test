"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, LayoutGrid, Loader2, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/app/_components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  createCanvas,
  listCanvases,
  renameCanvas,
  type CanvasListItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  CANVAS_STATUS_DOT,
  CANVAS_STATUS_DOT_FALLBACK,
  CANVAS_STATUS_LABEL,
  relativeTime,
} from "../_lib/canvas-status";
import { PHASE_UI } from "../_lib/thinking-phase";

import { ThinkingGrid } from "./thinking-indicator";

/** 分页缓存结构（useInfiniteQuery pages）：与 listCanvases 返回一致 */
type CanvasPage = { items: CanvasListItem[]; nextCursor: string | null };

/** 只给靠前的行排入场延时；再往后用户已经在滚动了，等待感比错落感更明显 */
const STAGGER_LIMIT = 14;
const STAGGER_STEP_MS = 35;

/**
 * 画布索引页（/canvas 未选中任何画布时）。
 *
 * 形态是「档案索引」而不是卡片墙：mono 序号给出阅读节奏，标题占主轴，
 * 状态与时间靠右对齐成一列，行与行之间只有一条极细分隔线。列表数据只有
 * 标题/状态/更新时间，没有节点信息，所以不做缩略图——不拿装饰冒充数据。
 *
 * 这一页不出现画布内的悬浮面板与边缘入口：那些是「在某块画布里」才成立的工具，
 * 这里的主任务只有一个——挑一块画布进去。
 */
export function CanvasGallery() {
  const router = useRouter();
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
      router.push(`/canvas/${r.sessionId}`);
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
                items: p.items.map((c) => (c.id === id ? { ...c, title } : c)),
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

  // 入口按钮：指针悬停或键盘聚焦时，方阵从待机灯切成思考态
  const [previewHot, setPreviewHot] = useState(false);

  const showEmpty = !list.isLoading && items.length === 0;

  return (
    <div className="relative h-full overflow-y-auto">
      {/* 点阵底纹（见 globals.css .canvas-gallery-grain）：这一页在讲「画布」这件事 */}
      <div
        aria-hidden
        className="canvas-gallery-grain pointer-events-none absolute inset-0"
      />

      <div className="relative mx-auto w-full max-w-4xl px-6 pb-24 pt-14 md:px-8 md:pt-20">
        <header className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            {/* 回上一层。用 <Link> 而不是 router.push：它是真正的站内导航，
                该能中键新开、能被读屏当链接播报（项目其它导航也都是 Link） */}
            <Link
              href="/"
              className="group/home -ml-1 mb-3 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
            >
              <ArrowLeft className="size-3.5 transition-transform duration-200 group-hover/home:-translate-x-0.5 motion-reduce:transition-none" />
              AgentSpark
            </Link>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Canvases
            </h1>
            {/* 元信息一律走 mono + tabular-nums：数字列对齐，长度变化时不会左右跳 */}
            <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">
              {list.isLoading
                ? "loading…"
                : `${items.length}${hasNextPage ? "+" : ""} board${items.length === 1 ? "" : "s"} · pick one to open`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 思考指示器规格页入口。图标直接用 ThinkingGrid：入口本身就是它要预览的东西，
                比塞一个 lucide 图标更说明问题。做成 icon-only ghost 是有意压低——
                它是组件规格页，不该和 New canvas 争位置。

                静置时是待机灯（这一页没有 agent 在跑），碰上去立刻转成思考态：
                这个入口通向的就是「思考中」，让它在被指到的那一刻自己演一遍。
                focus 走同一套，键盘用户拿到的反馈才和指针一致。
                canvas-thinking-instant 负责把 pulse 的错峰 delay 归零，理由见 globals.css。 */}
            <Link
              href="/thinking-preview"
              aria-label="Thinking indicator preview"
              title="Thinking indicator preview"
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              onMouseEnter={() => setPreviewHot(true)}
              onMouseLeave={() => setPreviewHot(false)}
              onFocus={() => setPreviewHot(true)}
              onBlur={() => setPreviewHot(false)}
            >
              <ThinkingGrid
                size={14}
                animation={
                  previewHot ? PHASE_UI.thinking.animation : "standby"
                }
                className={previewHot ? "canvas-thinking-instant" : undefined}
              />
            </Link>
            <ThemeToggle />
            <Button
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending}
            >
              {createMut.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              New canvas
            </Button>
          </div>
        </header>

        <div className="mt-10">
          {list.isLoading && (
            <div className="space-y-px">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 py-4">
                  <Skeleton className="h-3 w-6" />
                  <Skeleton className="h-4 flex-1 max-w-64" />
                  <Skeleton className="ml-auto h-3 w-16" />
                </div>
              ))}
            </div>
          )}

          {showEmpty && (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border py-20 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <LayoutGrid className="size-6" />
              </span>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  No canvases yet
                </p>
                <p className="max-w-xs text-pretty text-sm text-muted-foreground">
                  Create one, then describe the workflow in a sentence — the
                  agent wires up the nodes for you.
                </p>
              </div>
              <Button
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending}
              >
                <Plus /> New canvas
              </Button>
            </div>
          )}

          <ul>
            {items.map((c, i) => (
              <li
                key={c.id}
                className={cn("canvas-row-in", i < STAGGER_LIMIT && "opacity-0")}
                style={
                  i < STAGGER_LIMIT
                    ? { animationDelay: `${i * STAGGER_STEP_MS}ms` }
                    : undefined
                }
              >
                {c.id === editingId ? (
                  <div className="flex items-center gap-4 border-b border-border/70 py-3.5">
                    <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-muted-foreground/60">
                      {String(i + 1).padStart(3, "0")}
                    </span>
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
                      aria-label="Canvas name"
                      className="h-8 flex-1"
                    />
                  </div>
                ) : (
                  <div className="group relative border-b border-border/70">
                    <button
                      type="button"
                      onClick={() => router.push(`/canvas/${c.id}`)}
                      className={cn(
                        "flex w-full items-center gap-4 rounded-lg px-3 py-3.5 text-left transition-colors duration-200",
                        "-mx-3 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                        "motion-reduce:transition-none",
                      )}
                    >
                      {/* 序号是这一页的节奏基准：等宽数字，hover 时转主色，像被点名 */}
                      <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-muted-foreground/60 transition-colors group-hover:text-foreground motion-reduce:transition-none">
                        {String(i + 1).padStart(3, "0")}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">
                        {c.title}
                      </span>

                      {/* 状态：点 + 人话。光靠颜色分不了七种状态（ux: color-not-only） */}
                      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            CANVAS_STATUS_DOT[c.status] ??
                              CANVAS_STATUS_DOT_FALLBACK,
                          )}
                          aria-hidden
                        />
                        <span className="w-24 font-mono text-[11px] text-muted-foreground">
                          {CANVAS_STATUS_LABEL[c.status] ?? c.status}
                        </span>
                      </span>

                      <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                        {relativeTime(c.updatedAt)}
                      </span>

                      {/* 箭头只在 hover/聚焦时滑入：静态时列表更干净 */}
                      <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:translate-x-0 group-hover:opacity-100 motion-reduce:transition-none" />
                    </button>

                    {/* 重命名压在行右侧偏内的位置，避开箭头 */}
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      aria-label={`Rename ${c.title}`}
                      title="Rename"
                      className="absolute right-7 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100 motion-reduce:transition-none"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {/* 滚动加载哨兵：进入视口即拉下一页；加载中转圈 */}
          {hasNextPage && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-8"
            >
              {isFetchingNextPage && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
