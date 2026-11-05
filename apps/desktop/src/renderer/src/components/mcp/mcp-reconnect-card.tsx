
import { Loader2, PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";

import { connectMcpServer, type McpAuthRequired } from "./api";
import { useMcpConnect } from "./use-mcp-connect";

/**
 * 连接器授权失效（token 刷新也失败）时出现在工具调用之后的卡片（设计 Q8）：
 * 点「Reconnect」弹窗重新授权；授权完由用户手动重试，不自动重跑本轮。
 */
export function McpReconnectCard({ auth }: { auth: McpAuthRequired }) {
  const { connect, pendingId } = useMcpConnect();
  const pending = pendingId === auth.serverId;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
      <PlugZap className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{auth.serverName}</span>{" "}
        <span className="text-muted-foreground">
          needs to be reconnected. Reconnect, then ask again.
        </span>
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => void connect(auth.serverId, () => connectMcpServer(auth.serverId))}
      >
        {pending && <Loader2 className="animate-spin" />}
        Reconnect
      </Button>
    </div>
  );
}
