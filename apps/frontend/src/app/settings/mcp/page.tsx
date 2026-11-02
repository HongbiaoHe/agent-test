"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { AddConnectorDialog } from "./_components/add-connector-dialog";
import { ConnectorList } from "./_components/connector-list";

// /settings/mcp：MCP 连接器管理——已连接列表（启停 / 详情 / 工具权限）、推荐连接器一键连接、添加自定义 URL。
export default function McpSettingsPage() {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Connectors</h2>
          <p className="text-sm text-muted-foreground">
            Connect remote MCP servers so the agent can use their tools. Tools
            that ship an interactive app render as cards right in the chat.
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setAdding(true)}>
          <Plus /> Add connector
        </Button>
      </header>

      <ConnectorList />
      <AddConnectorDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}
