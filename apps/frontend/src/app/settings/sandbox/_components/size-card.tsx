"use client";

import { Check, CircleAlert, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import type { MigrationExcludes, SandboxMigration, SandboxSizeId } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSandboxMigration } from "../_hooks/use-sandbox-migration";
import { formatBytes, MigrationPlanner } from "./migration-planner";
import { useSandboxSettings } from "../_hooks/use-sandbox-settings";

/** 迁移步骤（与后端 SandboxMigration.phase 一致），进度列表按这个顺序画 */
const STEPS: { phase: string; label: string }[] = [
  { phase: "pack", label: "Pack workspace in the current sandbox" },
  { phase: "create", label: "Create the new sandbox" },
  { phase: "transfer", label: "Copy files into the new sandbox" },
  { phase: "verify", label: "Verify file count and size" },
  { phase: "switch", label: "Switch to the new sandbox" },
  { phase: "cleanup", label: "Delete the old sandbox" },
];

function isSizeId(v: unknown): v is SandboxSizeId {
  return v === "2c2g" || v === "4c4g" || v === "4c8g" || v === "8c8g";
}

function specLabel(cpuCount: number, memoryMB: number): string {
  return `${cpuCount} vCPU · ${memoryMB / 1024} GB`;
}


/**
 * 沙箱配置（vCPU / 内存）。换档 = 用新规格建一台新沙箱，把工作区搬过去（依赖目录不搬），
 * 文件数与总大小核对一致后删除旧沙箱。只有支持档位的提供方（E2B）可用。
 */
export function SizeCard() {
  const { query } = useSandboxSettings();
  const { query: migration, start } = useSandboxMigration();
  const [picked, setPicked] = useState<SandboxSizeId | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [planning, setPlanning] = useState(false);
  // 盘点里选好的排除项与预估，等确认弹窗点「Switch」才提交
  const [plan, setPlan] = useState<{
    excludes: MigrationExcludes;
    estimate: { files: number; bytes: number } | null;
  } | null>(null);

  const settings = query.data;
  const supported = settings?.providers.find((p) => p.name === settings.current)?.supportsSizes ?? false;
  const running = migration.data?.status === "running";
  const target = picked && picked !== settings?.size ? picked : null;
  const targetSpec = settings?.sizes.find((s) => s.id === target);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Size</CardTitle>
        <CardDescription>
          CPU and memory of the sandbox. Switching creates a new sandbox and moves your workspace
          into it. Before switching you can review what takes up space and choose which files and
          folders to leave behind.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : !settings ? null : !supported ? (
          <p className="text-sm text-muted-foreground">
            Size switching is available with the E2B provider only.
          </p>
        ) : (
          <>
            <RadioGroup
              aria-label="Sandbox size"
              value={picked ?? settings.size}
              onValueChange={(v) => {
                if (isSizeId(v)) setPicked(v);
              }}
              disabled={running || start.isPending}
              className="grid gap-2 sm:grid-cols-2"
            >
              {settings.sizes.map((s) => (
                <label
                  key={s.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent",
                    (picked ?? settings.size) === s.id && "border-primary/40 bg-accent/60",
                  )}
                >
                  <RadioGroupItem value={s.id} />
                  <span className="flex-1 text-sm font-medium tabular-nums">
                    {specLabel(s.cpuCount, s.memoryMB)}
                  </span>
                  {settings.size === s.id && <Badge variant="secondary">Current</Badge>}
                </label>
              ))}
            </RadioGroup>

            {!running && target && planning ? (
              <MigrationPlanner
                onCancel={() => setPlanning(false)}
                onConfirm={(excludes, estimate) => {
                  setPlan({ excludes, estimate });
                  setConfirm(true);
                }}
              />
            ) : !running && (
              <div className="flex items-center gap-3">
                <Button disabled={!target || start.isPending} onClick={() => setPlanning(true)}>
                  {start.isPending && <Loader2 className="animate-spin" />}
                  Review files
                </Button>
                {start.isError && (
                  <p className="text-sm text-destructive" role="alert">
                    {start.error instanceof Error ? start.error.message : "Failed to start"}
                  </p>
                )}
              </div>
            )}

            {migration.data && <MigrationStatus m={migration.data} />}
          </>
        )}
      </CardContent>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {targetSpec ? specLabel(targetSpec.cpuCount, targetSpec.memoryMB) : "the new size"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {plan?.estimate
                ? `${plan.estimate.files.toLocaleString()} files (${formatBytes(plan.estimate.bytes)}) will be copied into a new sandbox. `
                : "Your selected files will be copied into a new sandbox. "}
              Everything you left out — and packages installed system-wide — stays in the current
              sandbox, which is deleted once the copy is verified. The agent can&apos;t run until
              the switch finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={!target || !plan || start.isPending}
              onClick={() => {
                if (!target || !plan) return;
                setConfirm(false);
                start.mutate(
                  { size: target, excludes: plan.excludes },
                  {
                    onSuccess: () => {
                      setPicked(null);
                      setPlanning(false);
                      setPlan(null);
                    },
                  },
                );
              }}
            >
              Switch
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** 最近一次迁移：进行中画步骤进度，结束显示结果。 */
function MigrationStatus({ m }: { m: SandboxMigration }) {
  if (m.status === "running") {
    // prepare（找旧沙箱、唤醒）算在第一步里
    const current = Math.max(0, STEPS.findIndex((s) => s.phase === m.phase));
    return (
      <div className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
        <p className="text-sm font-medium">Moving to {m.toSize}…</p>
        <ol className="space-y-1.5">
          {STEPS.map((s, i) => (
            <li
              key={s.phase}
              className={cn(
                "flex items-center gap-2 text-sm",
                i > current ? "text-muted-foreground/60" : i < current ? "text-muted-foreground" : "",
              )}
            >
              {i < current ? (
                <Check className="size-3.5 shrink-0" />
              ) : i === current ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              {s.label}
              {s.phase === "pack" && i < current && m.fileCount != null && m.totalBytes != null && (
                <span className="text-xs tabular-nums">
                  {m.fileCount} files · {formatBytes(m.totalBytes)}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (m.status === "failed") {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>Switch to {m.toSize} failed: {m.message ?? "unknown error"}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Check className="mt-0.5 size-4 shrink-0" />
      <span>
        Switched from {m.fromSize} to {m.toSize}
        {m.fileCount != null && m.totalBytes != null
          ? ` · moved ${m.fileCount} files (${formatBytes(m.totalBytes)})`
          : ""}
        {m.message ? ` · ${m.message}` : ""}
      </span>
    </p>
  );
}
