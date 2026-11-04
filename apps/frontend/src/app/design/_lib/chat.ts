import type { DesignAttachment, DesignMessageRow } from "./api";

/**
 * agent 对话的投影：REST 历史行 + socket 流式事件 → 一条有序的条目列表。
 * 工具调用按 toolCallId 配对 tool_start / tool_end，渲染成一行「步骤」。
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string; attachments: DesignAttachment[]; at: number }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  /** 一段思考（按产生它的 AIMessage 归集：sourceId 相同的增量拼成一段）；at = 开始时间 */
  | { kind: "thinking"; id: string; sourceId: string; text: string; at: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      /** stopped = 运行被停止 / 中断时这一步还没做完 */
      status: "running" | "done" | "error" | "stopped";
      result?: string;
      /** 这一步涉及的图片图层：界面按画板上的实时状态显示它们的生成进度 */
      layerIds: string[];
      /** 开始 / 结束时间（ms），活动组按它算用时 */
      at: number;
      endAt?: number;
    }
  | { kind: "error"; id: string; message: string }
  | { kind: "note"; id: string; text: string };

export interface ChatState {
  items: ChatItem[];
}

export const EMPTY_CHAT: ChatState = { items: [] };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function attachments(v: unknown): DesignAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    const o = obj(a);
    return typeof o.url === "string"
      ? [
          {
            url: o.url,
            filename: str(o.filename),
            width: Number(o.width) || 0,
            height: Number(o.height) || 0,
          },
        ]
      : [];
  });
}

function toolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => str(obj(b).text)).join("\n");
  return "";
}

const IMAGE_LAYER_ID = /\bimg_[A-Za-z0-9_-]+/g;

/** 从工具参数里取它涉及的图片图层（生成某一层 / 等待指定的几层）。 */
function layerIdsFromArgs(name: string, args: Record<string, unknown>): string[] {
  if ((name === "generate_layer_image" || name === "decompose_layer") && typeof args.layerId === "string") {
    return [args.layerId];
  }
  if (name === "wait_for_layers" && Array.isArray(args.layerIds)) {
    return args.layerIds.filter((x): x is string => typeof x === "string");
  }
  return [];
}

/**
 * 参数里没有图层 id 的，从工具结果里取：add_layers 回「生图：已提交 img_x；…」，
 * wait_for_layers 回每层一行「img_x: status」。图层 id 由服务端生成，只能这样拿到。
 */
function layerIdsFromResult(name: string, result: string): string[] {
  if (name === "add_layers") {
    const gen = result.split("生图：")[1] ?? "";
    return [...new Set(gen.match(IMAGE_LAYER_ID) ?? [])];
  }
  if (name === "wait_for_layers") return [...new Set(result.match(IMAGE_LAYER_ID) ?? [])];
  return [];
}

/** at = 事件时间：实时事件取收到的时刻，历史行取落库时间 */
export type ChatEvent = { type: string; payload: unknown; id?: string; at: number };

/** 应用一条事件（历史行与实时事件同一套规则）。 */
export function reduceChat(state: ChatState, evt: ChatEvent): ChatState {
  const p = obj(evt.payload);
  const items = [...state.items];
  switch (evt.type) {
    case "token": {
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + str(p.text) };
      } else {
        items.push({ kind: "assistant", id: `stream-${Date.now()}`, text: str(p.text), streaming: true });
      }
      return { items };
    }
    case "reasoning": {
      // 实时推流是增量 / 整块，历史行是收口后的整段：都按 sourceId 拼进同一段思考
      const text = str(p.text);
      if (!text) return state;
      const sourceId = str(p.sourceId);
      const idx = sourceId
        ? items.findIndex((i) => i.kind === "thinking" && i.sourceId === sourceId)
        : items[items.length - 1]?.kind === "thinking" && !items[items.length - 1].id.startsWith("r:")
          ? items.length - 1
          : -1;
      const hit = idx >= 0 ? items[idx] : undefined;
      if (hit?.kind === "thinking") {
        items[idx] = { ...hit, text: hit.text + text };
      } else {
        // Gemini 的思考块要等这一步结束才从 updates 到达，晚于同一条消息的正文 token：
        // 末尾若是还在流的回复，思考插到它前面，顺序与刷新后从历史加载的一致
        const tail = items[items.length - 1];
        const at = tail?.kind === "assistant" && tail.streaming ? items.length - 1 : items.length;
        items.splice(at, 0, {
          kind: "thinking",
          id: sourceId ? `r:${sourceId}` : `t-${items.length}`,
          sourceId,
          text,
          at: evt.at,
        });
      }
      return { items };
    }
    case "message": {
      if (p.role === "user") {
        const id = str(p.id) || evt.id || `u-${items.length}`;
        if (items.some((i) => i.id === id)) return state;
        // 上一轮若是被中断的（进程重启时来不及写 result），它还在转圈的步骤到这里收口
        const closed = closeRunning(items, "stopped");
        closed.push({ kind: "user", id, text: str(p.text), attachments: attachments(p.attachments), at: evt.at });
        return { items: closed };
      }
      const text = str(p.text);
      // 定稿最近那条流式回复：它后面可能已经插进了同一条消息的思考（思考块比正文 token 晚到）
      const streamingIdx = items.findLastIndex((i) => i.kind === "assistant" && i.streaming);
      const streamingItem = streamingIdx >= 0 ? items[streamingIdx] : undefined;
      if (streamingItem?.kind === "assistant") {
        items[streamingIdx] = { ...streamingItem, text: text || streamingItem.text, streaming: false };
      } else if (text) {
        items.push({ kind: "assistant", id: evt.id ?? `a-${items.length}`, text, streaming: false });
      }
      return { items };
    }
    case "tool_start": {
      const calls = Array.isArray(p.tool_calls) ? p.tool_calls : [];
      // 流式文本若停在半截（工具调用前的口播），收口成普通消息
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, streaming: false };
      }
      for (const c of calls) {
        const call = obj(c);
        const id = str(call.id) || `t-${items.length}`;
        if (items.some((i) => i.kind === "tool" && i.id === id)) continue;
        const args = obj(call.args);
        items.push({
          kind: "tool",
          id,
          name: str(call.name),
          args,
          status: "running",
          layerIds: layerIdsFromArgs(str(call.name), args),
          at: evt.at,
        });
      }
      return { items };
    }
    case "tool_end": {
      const id = str(p.toolCallId);
      const idx = items.findIndex((i) => i.kind === "tool" && i.id === id);
      if (idx >= 0) {
        const it = items[idx];
        if (it.kind === "tool") {
          const result = toolResult(p.content);
          items[idx] = {
            ...it,
            status: p.status === "error" ? "error" : "done",
            result,
            endAt: evt.at,
            layerIds: it.layerIds.length ? it.layerIds : layerIdsFromResult(it.name, result),
          };
        }
      }
      return { ...state, items };
    }
    case "error":
      items.push({ kind: "error", id: evt.id ?? `e-${items.length}`, message: str(p.message) || "运行失败" });
      return { items: closeRunning(items, "error") };
    case "result": {
      const stopped = p.status === "stopped";
      const closed = closeRunning(items, stopped ? "stopped" : "done");
      if (stopped) closed.push({ kind: "note", id: evt.id ?? `n-${items.length}`, text: "已停止" });
      return { items: closed };
    }
    default:
      return state;
  }
}

/** 运行结束（完成 / 停止 / 失败）：还在转圈的步骤一并收口，流式文本定稿。 */
function closeRunning(items: ChatItem[], status: "done" | "error" | "stopped"): ChatItem[] {
  return items.map((i) =>
    i.kind === "tool" && i.status === "running"
      ? { ...i, status }
      : i.kind === "assistant" && i.streaming
        ? { ...i, streaming: false }
        : i,
  );
}

export function chatFromRows(rows: DesignMessageRow[]): ChatState {
  return rows.reduce<ChatState>(
    (s, r) =>
      reduceChat(s, {
        type: r.type,
        id: r.id,
        at: Date.parse(r.createdAt) || 0,
        payload: r.role === "user" ? { ...obj(r.content), role: "user", id: r.id } : r.content,
      }),
    EMPTY_CHAT,
  );
}

/** 工具步骤的人话标签（agent 智能感的关键：让用户看懂它在干什么）。 */
export function describeTool(name: string, args: Record<string, unknown>): string {
  const count = (k: string) => (Array.isArray(args[k]) ? args[k].length : 0);
  switch (name) {
    case "add_layers": {
      const layers = Array.isArray(args.layers) ? args.layers : [];
      const text = layers.filter((l) => obj(l).type === "text").length;
      const image = layers.length - text;
      return `添加 ${layers.length} 个图层${image && text ? `（${image} 图 · ${text} 文字）` : ""}`;
    }
    case "update_layers":
      return `调整 ${count("updates")} 个图层`;
    case "delete_layers":
      return `删除 ${count("ids")} 个图层`;
    case "reorder_layers":
      return "调整图层顺序";
    case "set_canvas":
      return args.width && args.height ? `设置画布 ${String(args.width)}×${String(args.height)}` : "设置画布";
    case "generate_layer_image":
      return args.engine === "seedream" ? "生成图片 · Seedream" : "生成图片";
    case "decompose_layer":
      return "拆分图层";
    case "inspect_layers":
      return `查看 ${count("layerIds")} 个图层`;
    case "wait_for_layers":
      return "等待图片生成";
    case "render_preview":
      return "审视版面";
    case "get_document":
      return "读取文档";
    case "write_todos":
      return "规划步骤";
    default:
      return name;
  }
}
