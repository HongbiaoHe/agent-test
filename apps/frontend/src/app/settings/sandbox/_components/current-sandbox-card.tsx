"use client";

import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSandboxStatus, type SandboxStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 状态 → 圆点颜色与文案（与 agent 页沙箱面板一致：运行=绿、停机=黄、无沙箱=灰）。 */
function toneOf(data: SandboxStatus) {
  if (!data.exists) return { dot: "bg-muted-foreground/40", label: "No sandbox yet" };
  if (data.state === "started") return { dot: "bg-success", label: "Running" };
  if (data.state === "stopped") return { dot: "bg-warning", label: "Stopped" };
  return { dot: "bg-warning", label: data.state ?? "Unknown" };
}

/**
 * 当前提供方下该用户的沙箱（只读）。与 agent 页沙箱面板共用 ["sandbox-status"] 缓存；
 * 查询只走 list()，不唤醒、不续命沙箱。
 */
export function CurrentSandboxCard() {
  const query = useQuery({
    queryKey: ["sandbox-status"],
    queryFn: () => fetchSandboxStatus(),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Current sandbox</CardTitle>
        <CardDescription>
          One sandbox per account, shared by all your conversations. It is created automatically
          when the agent first needs to run code.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : query.data ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                <span className={cn("size-2 rounded-full", toneOf(query.data).dot)} />
                {toneOf(query.data).label}
              </dd>
            </div>
            {query.data.exists && (
              <>
                <div className="min-w-0 space-y-0.5">
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="truncate font-mono text-xs leading-5">{query.data.id}</dd>
                </div>
                <div className="space-y-0.5">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="font-medium">
                    {query.data.createdAt ? new Date(query.data.createdAt).toLocaleString() : "—"}
                  </dd>
                </div>
              </>
            )}
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}
