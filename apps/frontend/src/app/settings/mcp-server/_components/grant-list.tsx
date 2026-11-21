"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";

import { AgentLogo, agentDisplayName } from "@/components/mcp-server/agent-logo";
import {
  listMcpGrants,
  MCP_GRANTS_KEY,
  type McpGrant,
  revokeMcpGrant,
  SCOPE_INFO,
} from "@/components/mcp-server/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** 已授权应用 + 访问令牌（同一张表：OAuth 同意一次一条，建一个令牌一条），可吊销 */
export function GrantList() {
  const grants = useQuery({ queryKey: MCP_GRANTS_KEY, queryFn: listMcpGrants });
  const [revoking, setRevoking] = useState<McpGrant | null>(null);

  if (grants.isLoading) {
    return <Skeleton className="h-18 w-full rounded-xl" />;
  }
  if (grants.isError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {grants.error instanceof Error ? grants.error.message : "Failed to load"}
        </CardContent>
      </Card>
    );
  }
  const list = grants.data ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <KeyRound className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No apps or tokens yet. Connect an app with OAuth or create a token.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      <div className="space-y-3">
        {list.map((g) => (
          <GrantRow key={g.id} grant={g} onRevoke={() => setRevoking(g)} />
        ))}
      </div>
      <RevokeDialog grant={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

function GrantRow({ grant, onRevoke }: { grant: McpGrant; onRevoke: () => void }) {
  const Icon = grant.kind === "pat" ? KeyRound : AppWindow;
  const expired = grant.expiresAt !== null && new Date(grant.expiresAt) < new Date();
  // 用过的显示 agent 的 logo（与画布上「xx is editing」同一套识别）；还没连过的按类型给图标
  const agent = grant.agent ? agentDisplayName(grant.agent) : null;
  return (
    <Card>
      <CardContent className="flex items-start gap-3">
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
          title={agent ?? undefined}
        >
          {grant.agent ? (
            <AgentLogo agent={grant.agent} className="size-4" />
          ) : (
            <Icon className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{grant.name}</span>
            <Badge variant="secondary">
              {grant.kind === "pat" ? "Access token" : "OAuth app"}
            </Badge>
            {expired && <Badge variant="destructive">Expired</Badge>}
          </div>
          <div className="flex flex-wrap gap-1">
            {grant.scopes.map((s) => (
              <Badge key={s} variant="outline">
                {SCOPE_INFO[s].label}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Created {fmt(grant.createdAt)} ·{" "}
            {grant.lastUsedAt
              ? `Last used ${fmt(grant.lastUsedAt)}${agent && agent !== grant.name ? ` by ${agent}` : ""}`
              : "Never used"}
            {grant.expiresAt && ` · Expires ${fmt(grant.expiresAt)}`}
          </p>
        </div>
        <Button variant="destructive" size="sm" onClick={onRevoke}>
          Revoke
        </Button>
      </CardContent>
    </Card>
  );
}

function RevokeDialog({
  grant,
  onClose,
}: {
  grant: McpGrant | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => revokeMcpGrant(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: MCP_GRANTS_KEY });
      onClose();
    },
  });
  return (
    <AlertDialog open={grant !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{grant?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It loses access to your canvases immediately. This can&apos;t be undone —
            the app has to be authorized again, or a new token created.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revoke.isPending}
            onClick={() => grant && revoke.mutate(grant.id)}
          >
            {revoke.isPending && <Loader2 className="animate-spin" />}
            Revoke
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
