"use client";

import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import type { SandboxProviderName } from "@/lib/api";
import { cn } from "@/lib/utils";

import { useSandboxSettings } from "../_hooks/use-sandbox-settings";

/** 各提供方的展示名与特性说明（与后端 sandbox-providers 的能力一致）。 */
const PROVIDER_COPY: Record<SandboxProviderName, { label: string; detail: string }> = {
  daytona: {
    label: "Daytona",
    detail: "Stops when idle and can be deleted after stopping. Graphical desktop available.",
  },
  e2b: {
    label: "E2B",
    detail: "Pauses when idle; the paused workspace is kept until you delete it. No graphical desktop.",
  },
};

function isProviderName(v: unknown): v is SandboxProviderName {
  return v === "daytona" || v === "e2b";
}

/** 沙箱提供方切换。服务端未配置 key 的提供方禁用。 */
export function ProviderCard() {
  const { query, mutation } = useSandboxSettings();
  const pendingProvider = mutation.isPending ? mutation.variables?.provider : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Provider</CardTitle>
        <CardDescription>
          The cloud sandbox where the agent runs code. Each provider keeps its own workspace, so
          files are not moved when you switch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading ? (
          <Skeleton className="h-28 w-full rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {query.error instanceof Error ? query.error.message : "Failed to load"}
          </p>
        ) : query.data ? (
          <RadioGroup
            aria-label="Sandbox provider"
            value={pendingProvider ?? query.data.current}
            onValueChange={(value) => {
              if (isProviderName(value) && value !== query.data.current) {
                mutation.mutate({ provider: value });
              }
            }}
            disabled={mutation.isPending}
          >
            {query.data.providers.map((p) => {
              const copy = PROVIDER_COPY[p.name];
              return (
                <label
                  key={p.name}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors",
                    p.configured ? "cursor-pointer hover:bg-accent" : "cursor-not-allowed opacity-60",
                    query.data.current === p.name && "border-primary/40 bg-accent/60",
                  )}
                >
                  <RadioGroupItem value={p.name} disabled={!p.configured} className="mt-0.5" />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {copy.label}
                      {query.data.default === p.name && (
                        <Badge variant="secondary">Server default</Badge>
                      )}
                      {!p.configured && <Badge variant="outline">Not configured</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">{copy.detail}</span>
                  </span>
                  {pendingProvider === p.name && (
                    <Loader2 className="mt-0.5 size-4 animate-spin text-muted-foreground" />
                  )}
                </label>
              );
            })}
          </RadioGroup>
        ) : null}
        {mutation.isError && mutation.variables?.provider !== undefined && (
          <p className="text-sm text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to switch sandbox"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
