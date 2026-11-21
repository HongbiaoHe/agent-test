"use client";

import { useQuery } from "@tanstack/react-query";

import { getMcpServerInfo, MCP_SERVER_INFO_KEY } from "@/components/mcp-server/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CopyBlock } from "./copy-button";
import { claudeCodeCommand, mcpJson } from "./snippets";

/** MCP 地址 + 接入片段（OAuth：客户端首次连接时弹浏览器授权，不用手动配令牌） */
export function ConnectCard() {
  const info = useQuery({ queryKey: MCP_SERVER_INFO_KEY, queryFn: getMcpServerInfo });
  if (!info.data) return <Skeleton className="h-56 w-full rounded-xl" />;
  const url = info.data.mcpUrl;

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Server URL</h3>
          <CopyBlock value={url} label="Copy server URL" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Connect with OAuth</h3>
          <p className="text-xs text-muted-foreground">
            Your app opens a browser window to sign in and approve access on first
            use — no token to paste.
          </p>
          <Tabs defaultValue="claude" className="flex-col">
            <TabsList>
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="json">mcp.json</TabsTrigger>
            </TabsList>
            <TabsContent value="claude">
              <CopyBlock value={claudeCodeCommand(url)} />
            </TabsContent>
            <TabsContent value="json">
              <CopyBlock value={mcpJson(url)} />
            </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>
  );
}
