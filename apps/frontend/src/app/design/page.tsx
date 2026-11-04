"use client";

import { CANVAS_PRESETS } from "@agent-test/design-schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { designApi, type DesignListItem } from "./_lib/api";

type Preset = (typeof CANVAS_PRESETS)[number];

/** 「我的设计」：设计稿列表（缩略图由后端同构渲染）+ 按常用尺寸新建。 */
export default function DesignListPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["design", "list"], queryFn: designApi.list });
  const create = useMutation({
    mutationFn: designApi.create,
    onSuccess: (snap) => router.push(`/design/${snap.id}`),
  });
  const remove = useMutation({
    mutationFn: designApi.remove,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["design", "list"] }),
  });
  const createFrom = (p: Preset) =>
    create.mutate({
      title: p.label,
      canvas: { width: p.width, height: p.height, background: "#F4F1EC" },
    });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6 flex items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-xl font-semibold">分图层设计</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">每一层都可以单独编辑，也可以交给 Agent 排版、生成或复刻。</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button disabled={create.isPending} />}>
              {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
              新建设计
              <ChevronDown className="opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {CANVAS_PRESETS.map((p) => (
                <DropdownMenuItem key={p.key} onClick={() => createFrom(p)}>
                  <AspectGlyph width={p.width} height={p.height} />
                  <span className="flex-1">{p.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {p.width}×{p.height}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {list.isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="aspect-4/3 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            ))}
          </div>
        ) : list.data?.length ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {list.data.map((d) => (
              <DesignCard key={d.id} item={d} onDelete={() => remove.mutate(d.id)} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-6 py-12">
            <p className="text-sm font-medium">还没有设计稿</p>
            <p className="mt-1 text-sm text-muted-foreground">选一个尺寸开始。之后可以随时在右侧面板里改画布大小。</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {CANVAS_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  variant="outline"
                  size="sm"
                  disabled={create.isPending}
                  onClick={() => createFrom(p)}
                >
                  <AspectGlyph width={p.width} height={p.height} />
                  {p.label}
                  <span className="text-muted-foreground tabular-nums">
                    {p.width}×{p.height}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 画幅示意：一个按比例缩放的小矩形，帮助在一列文字里快速认出横竖。 */
function AspectGlyph({ width, height }: { width: number; height: number }) {
  const max = 12;
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
      <span
        className="rounded-[2px] border border-current opacity-60"
        // 比例来自画布尺寸数据
        style={{
          width: width >= height ? max : (max * width) / height,
          height: height >= width ? max : (max * height) / width,
        }}
      />
    </span>
  );
}

function DesignCard({ item, onDelete }: { item: DesignListItem; onDelete: () => void }) {
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-foreground/20">
      <Link href={`/design/${item.id}`} className="block focus-visible:outline-none">
        <div className="flex aspect-4/3 items-center justify-center bg-workspace p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- 后端渲染的缩略图（带鉴权的同源反代），不走 next/image */}
          <img
            src={designApi.thumbnailUrl(item.id, item.revision)}
            alt={item.title}
            loading="lazy"
            className="max-h-full max-w-full rounded-[2px] object-contain shadow-sm ring-1 ring-border"
          />
        </div>
        <div className="px-3 py-2.5">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {item.canvas.width}×{item.canvas.height} · {item.layerCount} 个图层 ·{" "}
            {new Date(item.updatedAt).toLocaleDateString()}
          </p>
        </div>
      </Link>
      {item.status === "running" && (
        <span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs">
          <span className="size-1.5 animate-pulse rounded-full bg-agent motion-reduce:animate-none" />
          Agent 工作中
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="更多"
              className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
