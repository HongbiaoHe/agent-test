"use client";

import { getSession } from "next-auth/react";
import { io, type Socket } from "socket.io-client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

export type ConversationEventType =
  | "token"
  | "message"
  | "tool_start"
  | "tool_end"
  | "plan_update"
  | "control_request"
  | "result"
  | "error";

export interface ConversationEvent {
  seq: string;
  conversationId: string;
  type: ConversationEventType;
  payload: unknown;
  ts: number;
}

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, {
      transports: ["websocket"],
      // 连接时从 next-auth session 取 backendToken
      auth: async (cb) => {
        const session = (await getSession()) as { backendToken?: string } | null;
        cb({ token: session?.backendToken });
      },
    });
  }
  return socket;
}

/** 订阅某会话的流式事件，返回取消订阅函数。 */
export function subscribeConversation(
  conversationId: string,
  onEvent: (e: ConversationEvent) => void,
): () => void {
  const s = getSocket();
  const handler = (e: ConversationEvent) => {
    if (e.conversationId === conversationId) onEvent(e);
  };
  s.on("conversation:event", handler);
  s.emit("conversation:subscribe", { conversationId });
  return () => {
    s.off("conversation:event", handler);
  };
}

/** 提交审批决策（decisions 顺序对应 actionRequests）。 */
export function respondControl(conversationId: string, decisions: unknown[]) {
  getSocket().emit("control:response", { conversationId, decisions });
}
