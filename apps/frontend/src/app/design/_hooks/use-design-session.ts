"use client";

import { designOpBatchSchema, OP_SOURCES } from "@agent-test/design-schema";
import { useEffect, useReducer, useState } from "react";
import { z } from "zod";

import { designApi, type DesignRunStatus, type DesignSnapshot } from "../_lib/api";
import { type ChatEvent, type ChatState, chatFromRows, EMPTY_CHAT, reduceChat } from "../_lib/chat";
import { subscribeDesign } from "../_lib/socket";
import { DesignStore } from "../_lib/store";

type ChatAction = { type: "reset"; state: ChatState } | { type: "event"; event: ChatEvent };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  return action.type === "reset" ? action.state : reduceChat(state, action.event);
}

const RUN_STATUSES: readonly string[] = ["idle", "running", "done", "failed", "stopped"];

function isRunStatus(v: unknown): v is DesignRunStatus {
  return typeof v === "string" && RUN_STATUSES.includes(v);
}

/** socket 下发的 patch 是外部数据：用共享 op schema 解析，得到强类型且已校验的 op。 */
const patchPayloadSchema = z.object({
  ops: designOpBatchSchema,
  revision: z.number().int(),
  source: z.enum(OP_SOURCES),
  clientId: z.string(),
});

/**
 * 一个打开的设计稿：编辑器 store（文档）+ agent 对话投影，共用同一条 socket 订阅。
 * 快照由调用方先取好再传进来（store 需要初值），对话历史在这里异步补上。
 */
export function useDesignSession(snapshot: DesignSnapshot) {
  const [store] = useState(() => new DesignStore(snapshot));
  const [chat, dispatch] = useReducer(chatReducer, EMPTY_CHAT);
  const docId = snapshot.id;

  useEffect(() => {
    let alive = true;
    const loadHistory = () =>
      designApi
        .messages(docId)
        .then((rows) => {
          if (alive) dispatch({ type: "reset", state: chatFromRows(rows) });
        })
        .catch(() => {});
    const unsubscribe = subscribeDesign(
      docId,
      (e) => {
        switch (e.type) {
          case "design_patch": {
            const parsed = patchPayloadSchema.safeParse(e.payload);
            if (parsed.success) store.onPatch(parsed.data);
            else void store.resync();
            return;
          }
          case "design_focus": {
            const p = e.payload;
            if (p && typeof p === "object" && "layerIds" in p && Array.isArray(p.layerIds)) {
              const action = "action" in p && typeof p.action === "string" ? p.action : "";
              store.onFocus({
                layerIds: p.layerIds.filter((x): x is string => typeof x === "string"),
                action,
              });
            }
            return;
          }
          case "design_status": {
            const p = e.payload;
            const status = p && typeof p === "object" && "status" in p ? p.status : null;
            if (isRunStatus(status)) store.onStatus(status);
            return;
          }
          default:
            dispatch({ type: "event", event: { type: e.type, payload: e.payload, id: e.seq, at: Date.now() } });
        }
      },
      () => {
        // 重连：期间可能漏了事件，文档与对话都重新对齐
        void store.resync();
        void loadHistory();
      },
    );
    void loadHistory();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [docId, store]);

  return { store, chat };
}
