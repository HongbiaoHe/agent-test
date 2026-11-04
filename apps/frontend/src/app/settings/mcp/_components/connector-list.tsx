"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plug } from "lucide-react";
import { useState } from "react";

import {
  ConnectorIcon,
  ConnectorStatusBadge,
  connectMcpPreset,
  listMcpServers,
  MCP_SERVERS_KEY,
  type McpPreset,
  type McpServer,
  updateMcpServer,
  useMcpConnect,
} from "@/components/mcp";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { ConnectorDetailSheet } from "./connector-detail-sheet";

/** 连接器列表（已添加的）+ 推荐连接器区块。 */
export function ConnectorList() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const query = useQuery({ queryKey: MCP_SERVERS_KEY, queryFn: listMcpServers });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-18 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load connectors"}
        </CardContent>
      </Card>
    );
  }

  const { servers = [], presets = [] } = query.data ?? {};

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Your connectors
        </h3>
        {servers.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Plug className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No connectors yet — connect a recommended one below or add your own.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {servers.map((s) => (
              <ConnectorCard key={s.id} server={s} onOpen={() => setDetailId(s.id)} />
            ))}
          </div>
        )}
      </section>

      {presets.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Recommended
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {presets.map((p) => (
              <PresetCard key={p.key} preset={p} />
            ))}
          </div>
        </section>
      )}

      <ConnectorDetailSheet serverId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function ConnectorCard({ server, onOpen }: { server: McpServer; onOpen: () => void }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateMcpServer(server.id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY }),
  });
  const toolCount = server.tools.filter((t) => t.visibility.includes("model")).length;

  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        !server.enabled && "opacity-60",
      )}
      role="button"
      tabIndex={0}
      aria-label={`Open ${server.name} details`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <CardContent className="flex items-center gap-3 py-4">
        <ConnectorIcon src={server.serverInfo?.iconUrl} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{server.name}</span>
            <ConnectorStatusBadge status={server.status} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {server.url}
            {server.status === "connected" && ` · ${toolCount} tools`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Switch
            aria-label={server.enabled ? "Disable connector" : "Enable connector"}
            checked={server.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(checked) => toggle.mutate(checked)}
          />
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

function PresetCard({ preset }: { preset: McpPreset }) {
  const { connect, pendingId } = useMcpConnect();
  const pending = pendingId === preset.key;
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div className="flex items-center gap-3">
          <ConnectorIcon src={preset.iconUrl} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{preset.name}</p>
            <p className="truncate text-xs text-muted-foreground">{preset.url}</p>
          </div>
        </div>
        <p className="flex-1 text-sm text-muted-foreground">{preset.description}</p>
        <Button
          variant="outline"
          className="self-start"
          disabled={pending}
          onClick={() => void connect(preset.key, () => connectMcpPreset(preset.key))}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Plug />}
          Connect
        </Button>
      </CardContent>
    </Card>
  );
}
