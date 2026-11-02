"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Loader2, RefreshCw, Trash2, Unplug } from "lucide-react";
import { useState } from "react";

import {
  ConnectorIcon,
  ConnectorStatusBadge,
  connectMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  getMcpServer,
  MCP_SERVERS_KEY,
  type McpServer,
  type McpTool,
  mcpServerKey,
  type ToolPermission,
  updateMcpServer,
  useMcpConnect,
} from "@/components/mcp";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

const PERMISSION_LABEL: Record<ToolPermission, string> = {
  allow: "Always allow",
  ask: "Needs approval",
  deny: "Disabled",
};

function isPermission(v: unknown): v is ToolPermission {
  return typeof v === "string" && v in PERMISSION_LABEL;
}

/** 连接器详情侧拉：连接状态与操作（重连 / 断开 / 删除）+ 工具列表与逐个工具的权限（设计 Q4）。 */
export function ConnectorDetailSheet({
  serverId,
  onClose,
}: {
  serverId: string | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: mcpServerKey(serverId ?? ""),
    queryFn: () => getMcpServer(serverId!),
    enabled: serverId !== null,
  });
  const s = query.data;

  return (
    <Sheet open={serverId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            <ConnectorIcon src={s?.serverInfo?.iconUrl} className="size-8" />
            <span className="truncate">{s?.name ?? "Connector"}</span>
            {s && <ConnectorStatusBadge status={s.status} />}
          </SheetTitle>
          {s && (
            <SheetDescription className="truncate text-left">
              {s.url}
              {s.serverInfo?.version && ` · v${s.serverInfo.version}`}
            </SheetDescription>
          )}
        </SheetHeader>
        {/* 原生滚动：Sheet 内 ScrollArea 遇到不确定高度会退化（见 memory dialog-maxh-breaks-scrollarea） */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          {query.isLoading && (
            <div className="space-y-3 py-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          )}
          {query.isError && (
            <p className="py-4 text-sm text-destructive" role="alert">
              {query.error instanceof Error ? query.error.message : "Failed to load"}
            </p>
          )}
          {s && <ConnectorDetail server={s} onDeleted={onClose} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ConnectorDetail({ server, onDeleted }: { server: McpServer; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { connect, pendingId } = useMcpConnect();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
    void qc.invalidateQueries({ queryKey: mcpServerKey(server.id) });
  };

  const disconnect = useMutation({
    mutationFn: () => disconnectMcpServer(server.id),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteMcpServer(server.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      qc.removeQueries({ queryKey: mcpServerKey(server.id) });
      onDeleted();
    },
  });

  const connected = server.status === "connected";
  const modelTools = server.tools.filter((t) => t.visibility.includes("model"));
  const appOnlyTools = server.tools.filter((t) => !t.visibility.includes("model"));

  return (
    <div className="space-y-5">
      {server.serverInfo?.description && (
        <p className="text-sm text-muted-foreground">{server.serverInfo.description}</p>
      )}
      {server.lastError && (
        <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {server.lastError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant={connected ? "outline" : "default"}
          size="sm"
          disabled={pendingId === server.id}
          onClick={() => void connect(server.id, () => connectMcpServer(server.id))}
        >
          {pendingId === server.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {connected ? "Refresh tools" : "Reconnect"}
        </Button>
        {connected && server.authType === "oauth" && (
          <Button
            variant="outline"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            <Unplug /> Disconnect
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 /> Remove
        </Button>
      </div>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Tools ({modelTools.length})
        </h3>
        {server.tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {connected ? "This server exposes no tools." : "Connect to load this server's tools."}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {modelTools.map((t) => (
              <ToolRow key={t.name} serverId={server.id} tool={t} />
            ))}
          </ul>
        )}
      </section>

      {appOnlyTools.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            App-only tools ({appOnlyTools.length})
          </h3>
          <p className="text-xs text-muted-foreground">
            Used internally by this connector&apos;s interactive cards. The agent can&apos;t
            call them.
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {appOnlyTools.map((t) => (
              <ToolRow key={t.name} serverId={server.id} tool={t} />
            ))}
          </ul>
        </section>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will no longer be able to use its tools. Existing cards in your
              conversations stop working until you connect it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ToolRow({ serverId, tool }: { serverId: string; tool: McpTool }) {
  const qc = useQueryClient();
  const appOnly = !tool.visibility.includes("model");
  const incompatible = !appOnly && !tool.modelSchema;
  const update = useMutation({
    mutationFn: (permission: ToolPermission) =>
      updateMcpServer(serverId, { toolPermissions: { [tool.name]: permission } }),
    onSuccess: (server) => {
      qc.setQueryData(mcpServerKey(serverId), server);
      void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
    },
  });

  return (
    <li className="flex items-start gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="truncate font-mono text-sm">{tool.name}</code>
          {tool.uiResourceUri && (
            <Badge variant="outline" className="gap-1">
              <AppWindow className="size-3" /> Interactive
            </Badge>
          )}
          {tool.readOnly && <Badge variant="secondary">Read-only</Badge>}
          {incompatible && <Badge variant="destructive">Incompatible</Badge>}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {incompatible
            ? `Not available to the agent: ${tool.incompatibleReason ?? "unsupported input schema"}`
            : tool.description || tool.title || "(No description)"}
        </p>
      </div>
      {!appOnly && !incompatible && (
        <Select
          items={PERMISSION_LABEL}
          value={tool.permission}
          onValueChange={(v) => {
            if (isPermission(v)) update.mutate(v);
          }}
          disabled={update.isPending}
        >
          <SelectTrigger size="sm" aria-label={`Permission for ${tool.name}`} className="w-36 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERMISSION_LABEL) as ToolPermission[]).map((p) => (
              <SelectItem key={p} value={p}>
                {PERMISSION_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </li>
  );
}
