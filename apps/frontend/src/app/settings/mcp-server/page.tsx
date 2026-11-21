"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import { getMcpServerInfo, MCP_SERVER_INFO_KEY } from "@/components/mcp-server/api";
import { Button } from "@/components/ui/button";

import { ConnectCard } from "./_components/connect-card";
import { CreateTokenDialog } from "./_components/create-token-dialog";
import { GrantList } from "./_components/grant-list";

// /settings/mcp-server：让外部 agent（Claude Code、Cursor…）经 MCP 操作画布——接入地址与片段、
// 已授权应用 / 访问令牌的管理（设计见 docs/superpowers/specs/2026-11-21-canvas-mcp-server-design.md）。
export default function McpServerSettingsPage() {
  const [creating, setCreating] = useState(false);
  const info = useQuery({ queryKey: MCP_SERVER_INFO_KEY, queryFn: getMcpServerInfo });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">MCP access</h2>
        <p className="text-sm text-muted-foreground">
          Let external agents such as Claude Code or Cursor work on your canvases
          over MCP — the same tools the canvas agent uses.
        </p>
      </header>

      <ConnectCard />

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Authorized apps &amp; tokens
          </h3>
          <Button
            size="sm"
            variant="outline"
            disabled={!info.data}
            onClick={() => setCreating(true)}
          >
            <Plus /> Create token
          </Button>
        </div>
        <GrantList />
      </section>

      {info.data && (
        <CreateTokenDialog
          open={creating}
          onClose={() => setCreating(false)}
          mcpUrl={info.data.mcpUrl}
        />
      )}
    </div>
  );
}
