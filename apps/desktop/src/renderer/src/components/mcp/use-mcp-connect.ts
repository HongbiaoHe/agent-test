import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { agent } from "@/lib/agent-client";
import { i18n } from "@/lib/i18n";

import { type ConnectResult, MCP_SERVERS_KEY, mcpServerKey } from "./api";

/** 等授权回调的最长时间（同 agent-host 侧未完成授权的 10 分钟有效期） */
const AUTH_WAIT_MS = 10 * 60_000;

/**
 * 连接 / 重连 MCP 连接器（桌面端版 Web use-mcp-connect：返回同样的 { connect, pendingId }）。
 * 需要授权时在**系统浏览器**打开授权页（RFC 8252 原生应用做法），授权服务器回调到 agent-host 的
 * loopback 地址；结果以 agent-host 推来的 mcp-oauth 事件为准（成功 / 失败都会推）。
 */
export function useMcpConnect() {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const waiter = useRef<(() => void) | null>(null);

  const refresh = useCallback(
    (serverId?: string) => {
      void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      if (serverId) void qc.invalidateQueries({ queryKey: mcpServerKey(serverId) });
    },
    [qc],
  );

  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind !== "event") return;
        if (e.type === "mcp-changed") refresh();
        if (e.type !== "mcp-oauth") return;
        refresh(e.serverId);
        if (e.ok) toast.success(i18n.t("extensions.mcp.toast.oauthConnected"));
        else toast.error(e.error ?? i18n.t("extensions.mcp.toast.authFailed"));
        waiter.current?.();
      }),
    [refresh],
  );

  const connect = useCallback(
    async (key: string, start: () => Promise<ConnectResult>): Promise<void> => {
      setPendingId(key);
      try {
        const result = await start();
        refresh(result.server.id);
        if (result.status === "connected") {
          toast.success(i18n.t("extensions.mcp.toast.connected", { name: result.server.name }));
          return;
        }
        if (result.status === "error") {
          toast.error(
            i18n.t("extensions.mcp.toast.connectFailed", { name: result.server.name, error: result.error }),
          );
          return;
        }
        await window.desktop.openExternal(result.authorizationUrl);
        toast.info(i18n.t("extensions.mcp.toast.finishInBrowser", { name: result.server.name }));
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(finish, AUTH_WAIT_MS);
          function finish() {
            window.clearTimeout(timer);
            waiter.current = null;
            resolve();
          }
          waiter.current = finish;
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : i18n.t("extensions.mcp.toast.failed"));
      } finally {
        setPendingId(null);
      }
    },
    [refresh],
  );

  return { connect, pendingId };
}
