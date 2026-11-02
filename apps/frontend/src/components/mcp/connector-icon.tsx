"use client";

import { Plug } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { McpServerStatus } from "./api";

/** 连接器图标：server 自报的 icon（serverInfo.icons）优先，加载失败或没有时用 lucide Plug。 */
export function ConnectorIcon({
  src,
  className,
}: {
  src?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      {src && !failed ? (
        // 第三方 server 的图标地址，运行时才知道，next/image 无法预配置域名，用原生 <img>
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Plug className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

const STATUS_LABEL: Record<McpServerStatus, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  needs_auth: "Needs reconnect",
  error: "Error",
};

/** 连接状态徽章：已连接带绿点，需要处理的用警示 / 危险色。 */
export function ConnectorStatusBadge({ status }: { status: McpServerStatus }) {
  return (
    <Badge
      variant={status === "error" ? "destructive" : status === "connected" ? "secondary" : "outline"}
      className="gap-1.5"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "connected"
            ? "bg-success"
            : status === "needs_auth"
              ? "bg-warning"
              : status === "error"
                ? "bg-destructive"
                : "bg-muted-foreground",
        )}
      />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
