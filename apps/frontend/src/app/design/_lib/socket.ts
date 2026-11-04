"use client";

import { io, type Socket } from "socket.io-client";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3101";

/** 设计稿事件（后端 DesignGateway，namespace `/design`）。 */
export interface DesignEvent {
  seq: string;
  conversationId: string; // 信封字段名沿用；此处即 docId
  type:
    | "design_patch"
    | "design_focus"
    | "design_status"
    | "token"
    | "reasoning"
    | "message"
    | "tool_start"
    | "tool_end"
    | "plan_update"
    | "result"
    | "error";
  payload: unknown;
  ts: number;
}

let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    const isAbsolute = /^https?:\/\//.test(API_BASE);
    // 同画布：Authorization 由 middleware 注入 /api-backend；带 polling 兜底（Next dev 不转发 ws 升级）
    socket = isAbsolute
      ? io(`${API_BASE}/design`, { transports: ["websocket"] })
      : io("/design", {
          path: `${API_BASE}/socket.io`,
          transports: ["websocket", "polling"],
          extraHeaders: { "ngrok-skip-browser-warning": "1" },
        });
  }
  return socket;
}

/** 订阅某设计稿的实时事件，返回取消订阅函数。onReconnect：重连后需重新对齐快照。 */
export function subscribeDesign(
  docId: string,
  onEvent: (e: DesignEvent) => void,
  onReconnect?: () => void,
): () => void {
  const s = getSocket();
  const handler = (e: DesignEvent) => {
    if (e.conversationId === docId) onEvent(e);
  };
  let seenConnect = s.connected;
  const onConnect = () => {
    s.emit("design:subscribe", { docId });
    if (seenConnect) onReconnect?.();
    seenConnect = true;
  };
  s.on("design:event", handler);
  s.on("connect", onConnect);
  if (s.connected) s.emit("design:subscribe", { docId });
  return () => {
    s.off("design:event", handler);
    s.off("connect", onConnect);
  };
}
