"use client";

import { io, type Socket } from "socket.io-client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3101";

export type ConversationEventType =
  | "token"
  | "message"
  | "tool_start"
  | "tool_end"
  | "plan_update"
  | "control_request"
  | "result"
  | "error"
  // 媒体生成状态变更（不落 messages 表，仅实时下发）；前端据此 invalidate media query。
  | "media_update";

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
    const isAbsolute = /^https?:\/\//.test(API_BASE);
    // Authorization header 由 Next.js middleware 注入（与 REST 统一），不再在前端调 getSession()。
    // 带 polling 兜底——Next dev 不转发 websocket 升级，经隧道时会自动回退到 polling（HTTP，可被反代）。
    socket = isAbsolute
      ? io(API_BASE, { transports: ["websocket"] })
      : io({
          path: `${API_BASE}/socket.io`,
          transports: ["websocket", "polling"],
          extraHeaders: { "ngrok-skip-browser-warning": "1" },
        });
  }
  return socket;
}

/**
 * 订阅某会话的流式事件，返回取消订阅函数。
 * onReconnect：socket 重连后触发（重连是新连接，网关不记得旧订阅，需重新订阅并对齐历史）。
 */
export function subscribeConversation(
  conversationId: string,
  onEvent: (e: ConversationEvent) => void,
  onReconnect?: () => void,
): () => void {
  const s = getSocket();
  const handler = (e: ConversationEvent) => {
    if (e.conversationId === conversationId) onEvent(e);
  };
  // 已连接过一次后，再触发 connect 即为重连
  let seenConnect = s.connected;
  const onConnect = () => {
    s.emit("conversation:subscribe", { conversationId });
    if (seenConnect) onReconnect?.();
    seenConnect = true;
  };
  s.on("conversation:event", handler);
  s.on("connect", onConnect);
  // 首次：已连接则立即订阅；未连接则由 connect 事件触发
  if (s.connected) s.emit("conversation:subscribe", { conversationId });
  return () => {
    s.off("conversation:event", handler);
    s.off("connect", onConnect);
  };
}

/** 提交审批决策（decisions 顺序对应 actionRequests）。 */
export function respondControl(conversationId: string, decisions: unknown[]) {
  getSocket().emit("control:response", { conversationId, decisions });
}
