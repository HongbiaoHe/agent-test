"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, Link2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  estimateSandboxMigration,
  fetchSandboxInventory,
  type InventoryEntry,
  type MigrationExcludes,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const inventoryKey = (path: string) => ["sandbox-inventory", path] as const;

/**
 * 迁移前盘点：按目录列出文件 / 文件夹占用（大到小，可逐层展开），按类型一键排除，底部实时显示
 * 「将迁移多少」（后端按当前排除项精确统计，与迁移时校验同一口径）。
 * 找到的依赖目录默认排除，可以改回来；其余默认都迁移。
 */
export function MigrationPlanner({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (excludes: MigrationExcludes, estimate: { files: number; bytes: number } | null) => void;
}) {
  const root = useQuery({
    queryKey: inventoryKey(""),
    queryFn: () => fetchSandboxInventory(""),
    staleTime: 30_000,
  });
  // 路径勾选：true = 排除、false = 迁移；没手动动过的按默认（依赖目录排除，其余迁移）
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [exts, setExts] = useState<string[]>([]);

  const defaults = useMemo(
    () => new Set((root.data?.root?.dependencies ?? []).map((d) => d.path)),
    [root.data],
  );
  const isExcluded = (path: string) => manual[path] ?? defaults.has(path);
  const excludes = useMemo<MigrationExcludes>(() => {
    const paths = new Set([...defaults].filter((p) => manual[p] !== false));
    for (const [p, v] of Object.entries(manual)) if (v) paths.add(p);
    return { paths: [...paths].sort(), exts: [...exts].sort() };
  }, [defaults, manual, exts]);

  // 勾选停下 600ms 再统计（每次统计要在沙箱里遍历一遍工作区）
  const [settled, setSettled] = useState(excludes);
  useEffect(() => {
    const t = setTimeout(() => setSettled(excludes), 600);
    return () => clearTimeout(t);
  }, [excludes]);
  const settledKey = JSON.stringify(settled);
  const estimate = useQuery({
    queryKey: ["sandbox-estimate", settledKey],
    queryFn: () => estimateSandboxMigration(settled),
    enabled: root.isSuccess,
    staleTime: 60_000,
  });
  const estimating = estimate.isFetching || settledKey !== JSON.stringify(excludes);

  if (root.isLoading) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Listing files in your sandbox…
        </p>
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    );
  }
  if (root.isError || !root.data?.root) {
    return (
      <div className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-sm text-destructive" role="alert">
          {root.error instanceof Error ? root.error.message : "Could not list your sandbox files"}
        </p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Back
        </Button>
      </div>
    );
  }
  const { total, types } = root.data.root;
  const toggle = (path: string, exclude: boolean) => setManual((m) => ({ ...m, [path]: exclude }));

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">Choose what to move</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          Your workspace has {total.files.toLocaleString()} files · {formatBytes(total.bytes)}.
          Unchecked items stay behind and are deleted with the old sandbox.
        </p>
      </div>

      {types.length > 0 && (
        <section className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Skip by file type</p>
          <div className="flex flex-wrap gap-1.5">
            {types.slice(0, 12).map((t) => {
              const on = exts.includes(t.ext);
              return (
                <label
                  key={t.ext}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent",
                    on && "border-primary/40 bg-accent/60",
                  )}
                >
                  <Checkbox
                    checked={on}
                    onCheckedChange={(c) =>
                      setExts((xs) => (c === true ? [...xs, t.ext] : xs.filter((x) => x !== t.ext)))
                    }
                  />
                  <span className="font-medium">.{t.ext}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {t.files} · {formatBytes(t.bytes)}
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Files and folders</p>
        <div className="max-h-80 overflow-y-auto rounded-md border border-border py-1">
          <TreeLevel
            path=""
            depth={0}
            parentBytes={total.bytes}
            isExcluded={isExcluded}
            skippedExts={exts}
            ancestorExcluded={false}
            onToggle={toggle}
          />
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="flex items-center gap-2 text-sm tabular-nums" aria-live="polite">
          {estimating && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {estimate.data ? (
            <span>
              Will move <span className="font-medium">{estimate.data.files.toLocaleString()} files</span> ·{" "}
              <span className="font-medium">{formatBytes(estimate.data.bytes)}</span>
            </span>
          ) : estimate.isError ? (
            <span className="text-destructive">Could not estimate</span>
          ) : (
            <span className="text-muted-foreground">Calculating…</span>
          )}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={estimating || !estimate.data}
            onClick={() => onConfirm(excludes, estimate.data ?? null)}
          >
            Switch and move files
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 目录树的一层：大到小排序，文件夹可展开（展开时才去盘点下一层），勾选 = 迁移。 */
function TreeLevel({
  path,
  depth,
  parentBytes,
  isExcluded,
  skippedExts,
  ancestorExcluded,
  onToggle,
}: {
  path: string;
  depth: number;
  parentBytes: number;
  isExcluded: (path: string) => boolean;
  skippedExts: string[];
  ancestorExcluded: boolean;
  onToggle: (path: string, exclude: boolean) => void;
}) {
  const q = useQuery({
    queryKey: inventoryKey(path),
    queryFn: () => fetchSandboxInventory(path),
    staleTime: 30_000,
  });
  if (q.isLoading) {
    return (
      <p className="flex items-center gap-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: 12 + depth * 16 }}>
        <Loader2 className="size-3 animate-spin" /> Loading…
      </p>
    );
  }
  if (!q.data) {
    return (
      <p className="py-1 text-xs text-destructive" style={{ paddingLeft: 12 + depth * 16 }}>
        Could not list this folder
      </p>
    );
  }
  return (
    <ul>
      {q.data.entries.map((e) => (
        <TreeRow
          key={e.name}
          entry={e}
          path={path ? `${path}/${e.name}` : e.name}
          depth={depth}
          parentBytes={parentBytes}
          isExcluded={isExcluded}
          skippedExts={skippedExts}
          ancestorExcluded={ancestorExcluded}
          onToggle={onToggle}
        />
      ))}
      {q.data.truncated && (
        <li className="py-1 text-xs text-muted-foreground tabular-nums" style={{ paddingLeft: 36 + depth * 16 }}>
          …and {q.data.truncated.count} more ({formatBytes(q.data.truncated.bytes)}) — uncheck this folder to skip
          them
        </li>
      )}
    </ul>
  );
}

function TreeRow({
  entry,
  path,
  depth,
  parentBytes,
  isExcluded,
  skippedExts,
  ancestorExcluded,
  onToggle,
}: {
  entry: InventoryEntry;
  path: string;
  depth: number;
  parentBytes: number;
  isExcluded: (path: string) => boolean;
  skippedExts: string[];
  ancestorExcluded: boolean;
  onToggle: (path: string, exclude: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // 按类型跳过的文件：显示为不迁移、不可单独勾回（要迁移就取消上面的类型）
  const ext = entry.type === "file" ? entry.name.split(".").pop()?.toLowerCase() : undefined;
  const skippedByType = !!ext && entry.name.includes(".") && skippedExts.includes(ext);
  const locked = ancestorExcluded || skippedByType;
  const excluded = locked || isExcluded(path);
  const Icon = entry.type === "dir" ? Folder : entry.type === "link" ? Link2 : File;
  const share = parentBytes > 0 ? Math.min(100, (entry.bytes / parentBytes) * 100) : 0;
  return (
    <li>
      <div
        className={cn("group flex items-center gap-2 py-1 pr-3 text-sm hover:bg-accent/50", excluded && "text-muted-foreground")}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {entry.type === "dir" ? (
          <button
            type="button"
            aria-label={open ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <Checkbox
          aria-label={`Move ${path}`}
          checked={!excluded}
          disabled={locked}
          onCheckedChange={(c) => onToggle(path, c !== true)}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 flex-1 truncate", excluded && "line-through decoration-muted-foreground/50")} title={path}>
          {entry.name}
        </span>
        {skippedByType && <span className="shrink-0 text-xs text-muted-foreground">skipped .{ext}</span>}
        {/* 占父级的比例：一眼看出大头 */}
        <span className="hidden h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
          <span className="block h-full rounded-full bg-muted-foreground/40" style={{ width: `${share}%` }} />
        </span>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums">{formatBytes(entry.bytes)}</span>
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
          {entry.type === "dir" ? `${entry.files.toLocaleString()} files` : ""}
        </span>
      </div>
      {open && entry.type === "dir" && (
        <TreeLevel
          path={path}
          depth={depth + 1}
          parentBytes={entry.bytes}
          isExcluded={isExcluded}
          skippedExts={skippedExts}
          ancestorExcluded={excluded}
          onToggle={onToggle}
        />
      )}
    </li>
  );
}
