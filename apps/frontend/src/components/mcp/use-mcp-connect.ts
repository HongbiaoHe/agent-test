"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { type ConnectResult, MCP_SERVERS_KEY, mcpServerKey } from "./api";

/** OAuth 回调页（后端 /mcp/oauth/callback）经 BroadcastChannel 广播的结果。 */
interface OAuthMessage {
  type: "mcp-oauth";
  ok: boolean;
  serverId?: string;
  error?: string;
}

function isOAuthMessage(v: unknown): v is OAuthMessage {
  return (
    !!v &&
    typeof v === "object" &&
    "type" in v &&
    v.type === "mcp-oauth" &&
    "ok" in v &&
    typeof v.ok === "boolean"
  );
}

const CHANNEL = "mcp-oauth";
/** 与后端回调页约定的 sessionStorage 键（mcp.controller.ts callbackHtml） */
const REDIRECT_FLAG = "mcp-oauth-redirect";
const POPUP_FEATURES = "popup,width=520,height=720";

/**
 * 连接 / 重连 MCP 连接器（设计 Q8：弹窗授权）。
 * - 弹窗必须在点击的同步阶段先开（否则会被浏览器拦截），拿到授权 URL 后再导航过去；
 *   已有有效 token 直接连上则关掉弹窗；弹窗被拦截时退化为整页跳转，回调页会跳回 /settings/mcp。
 * - 授权结果走 BroadcastChannel（回调页与本站同源）。授权页若设了 COOP，弹窗的 closed 会立刻读成 true，
 *   所以「弹窗关了」只用来停掉按钮转圈，结果以广播为准：晚到的广播照样刷新列表并提示。
 */
export function useMcpConnect() {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** 正在等授权的那次 connect：广播到达时结束它 */
  const waiter = useRef<((msg: OAuthMessage) => void) | null>(null);

  const refresh = useCallback(
    (serverId?: string) => {
      void qc.invalidateQueries({ queryKey: MCP_SERVERS_KEY });
      if (serverId) void qc.invalidateQueries({ queryKey: mcpServerKey(serverId) });
    },
    [qc],
  );

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev: MessageEvent) => {
      if (!isOAuthMessage(ev.data)) return;
      const msg = ev.data;
      refresh(msg.serverId);
      if (msg.ok) toast.success("Connector connected");
      else toast.error(msg.error ?? "Authorization failed");
      waiter.current?.(msg);
    };
    return () => ch.close();
  }, [refresh]);

  const connect = useCallback(
    async (key: string, start: () => Promise<ConnectResult>): Promise<void> => {
      const popup = window.open("", CHANNEL, POPUP_FEATURES);
      setPendingId(key);
      try {
        const result = await start();
        refresh(result.server.id);
        if (result.status === "connected") {
          popup?.close();
          toast.success(`${result.server.name} connected`);
          return;
        }
        if (result.status === "error") {
          popup?.close();
          toast.error(`Couldn't connect to ${result.server.name}: ${result.error}`);
          return;
        }
        if (!popup) {
          // 标记「本标签页是整页跳去授权的」：回调页（同源）据此跳回设置页，而不是自关整个标签页
          try {
            sessionStorage.setItem(REDIRECT_FLAG, "1");
          } catch {
            // 无痕 / 禁用存储：回调页关不掉窗口时也会自己跳回设置页
          }
          window.location.href = result.authorizationUrl;
          return;
        }
        popup.location.href = result.authorizationUrl;
        await new Promise<void>((resolve) => {
          const timer = window.setInterval(() => {
            if (popup.closed) finish();
          }, 500);
          function finish() {
            window.clearInterval(timer);
            waiter.current = null;
            resolve();
          }
          waiter.current = finish;
        });
      } catch (e) {
        popup?.close();
        toast.error(e instanceof Error ? e.message : "Couldn't connect");
      } finally {
        setPendingId(null);
      }
    },
    [refresh],
  );

  return { connect, pendingId };
}
