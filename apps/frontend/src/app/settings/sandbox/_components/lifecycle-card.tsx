"use client";

import { Loader2 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { SandboxLifecycle } from "@/lib/api";

import { useSandboxSettings } from "../_hooks/use-sandbox-settings";

/** 闲置停机/暂停时长预设（后端允许 1–60；E2B 默认 1、Daytona 默认 5）。 */
const IDLE_PRESETS = [1, 2, 3, 5, 10, 15, 30, 60];
/** 停机后自动删除预设（后端允许 -1 或 1–10080）。 */
const AUTO_DELETE_PRESETS = [10, 30, 60, 1440, 10080, -1];

function formatMinutes(min: number): string {
  if (min === -1) return "Never";
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min} min`;
}

/** 选项 = 预设 ∪ 当前值（当前值可能经 API 设成非预设值），值用字符串承载。 */
function optionsWith(presets: number[], current: number): Record<string, string> {
  const values = presets.includes(current) ? presets : [...presets, current];
  return Object.fromEntries(values.map((v) => [String(v), formatMinutes(v)]));
}

type LifecycleField = keyof SandboxLifecycle;

/** 沙箱生命周期：闲置停机/暂停、停机后自动删除。改动即保存，并立即应用到现有沙箱。 */
export function LifecycleCard() {
  const { query, mutation } = useSandboxSettings();
  const data = query.data;
  const current = data?.providers.find((p) => p.name === data.current);
  const autoDeleteSupported = current?.supportsAutoDelete ?? false;

  const pendingField = (field: LifecycleField) =>
    mutation.isPending && mutation.variables?.[field] !== undefined;

  const save = (field: LifecycleField, raw: string | null) => {
    const value = Number(raw);
    if (!data || raw === null || Number.isNaN(value) || value === data.lifecycle[field]) return;
    mutation.mutate({ [field]: value });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lifecycle</CardTitle>
        <CardDescription>
          Controls how long an idle sandbox keeps running. Changes apply to your current sandbox
          right away.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {query.error instanceof Error ? query.error.message : "Failed to load"}
          </p>
        ) : data ? (
          <>
            <SettingRow
              label="Auto-stop when idle"
              hint={
                data.current === "e2b"
                  ? "The sandbox pauses after this long without activity."
                  : "The sandbox stops after this long without activity."
              }
              pending={pendingField("idleMinutes")}
            >
              <Select
                items={optionsWith(IDLE_PRESETS, data.lifecycle.idleMinutes)}
                value={String(data.lifecycle.idleMinutes)}
                onValueChange={(v) => save("idleMinutes", v)}
                disabled={mutation.isPending}
              >
                <SelectTrigger aria-label="Auto-stop when idle" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(optionsWith(IDLE_PRESETS, data.lifecycle.idleMinutes)).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Auto-delete after stopping"
              hint={
                autoDeleteSupported
                  ? "A stopped sandbox and its workspace files are deleted after this long."
                  : "Not available for E2B: paused sandboxes are kept until deleted."
              }
              pending={pendingField("autoDeleteMinutes")}
            >
              <Select
                items={optionsWith(AUTO_DELETE_PRESETS, data.lifecycle.autoDeleteMinutes)}
                value={String(data.lifecycle.autoDeleteMinutes)}
                onValueChange={(v) => save("autoDeleteMinutes", v)}
                disabled={!autoDeleteSupported || mutation.isPending}
              >
                <SelectTrigger aria-label="Auto-delete after stopping" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(
                    optionsWith(AUTO_DELETE_PRESETS, data.lifecycle.autoDeleteMinutes),
                  ).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </>
        ) : null}
        {mutation.isError && mutation.variables?.provider === undefined && (
          <p className="text-sm text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SettingRow({
  label,
  hint,
  pending,
  children,
}: {
  label: string;
  hint: string;
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {children}
      </div>
    </div>
  );
}
