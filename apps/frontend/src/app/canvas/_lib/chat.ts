import type { CanvasMessage } from "@/lib/api";

/**
 * 画布 agent 聊天区的归一事件与折叠 reducer（精简版：只管对话流，画布结构与 token 由各自 hook 处理）。
 * DB 历史（CanvasMessage）与 socket 增量都归一成 ChatEvent 喂给同一个 reduce。
 */
export interface ChatEvent {
  type: string;
  role?: string;
  payload: Record<string, unknown>;
}

/** 一次中断里挂起的单个工具调用。 */
export interface AskAction {
  /** 工具名：ask_user（提问）| clear_canvas（清空确认）| generate_media_node（生成确认）等。 */
  tool: string;
  /** 面板上该项的说明文案（ask_user 是问题本身，确认型是操作摘要）。 */
  label: string;
}

export interface AskRequest {
  /** 首个挂起调用的工具名，前端据此选交互形态（提问框 / 确认按钮）。 */
  tool: string;
  question: string;
  options: string[];
  /**
   * 本次中断挂起的**全部**工具调用（模型可一轮并行发多个，如 6 个 generate_media_node）。
   * resume 的 decisions 必须与它一一对应、数量相等，否则 langchain HITL 会抛
   * 「Number of human decisions (n) does not match number of hanging tool calls (m)」。
   */
  actions: AskAction[];
}

export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  /** 模型思考过程（推理型模型才有）：流式累加，其后第一个其它事件到来即收口。 */
  | { id: string; kind: "reasoning"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "tool";
      name: string;
      done: boolean;
      args?: Record<string, unknown>;
      result?: string;
    }
  | { id: string; kind: "plan"; todos: { content: string; status: string }[] }
  | { id: string; kind: "error"; message: string };

export interface ChatState {
  items: ChatItem[];
  status: "idle" | "running" | "done" | "failed";
  ask: AskRequest | null;
  nextId: number;
}

export const emptyChat: ChatState = {
  items: [],
  status: "idle",
  ask: null,
  nextId: 0,
};

function extractAsk(payload: Record<string, unknown>): AskRequest | null {
  // control_request 值：{ actionRequests: [{ name:'ask_user', args:{question, options} }, ...], ... }
  // 数组长度 = 本轮挂起的工具调用数，必须整批保留（决策要一一对应）。
  const reqs = (payload as { actionRequests?: unknown[] }).actionRequests;
  const list = Array.isArray(reqs) && reqs.length > 0 ? reqs : [undefined];
  const actions = list.map((r) => {
    const tool =
      typeof (r as { name?: string } | undefined)?.name === "string"
        ? (r as { name: string }).name
        : "ask_user";
    const args = (r as { args?: Record<string, unknown> } | undefined)?.args;
    // generate_media_node 无 question 参数：给确认面板生成友好文案（带目标节点 id）
    const fallback =
      tool === "generate_media_node"
        ? `Run generation for this node?${typeof args?.nodeId === "string" ? ` (node ${args.nodeId})` : ""}`
        : "Needs your approval to continue";
    const label =
      typeof args?.question === "string" ? args.question : fallback;
    return { tool, label };
  });
  const firstArgs = (list[0] as { args?: Record<string, unknown> } | undefined)
    ?.args;
  const options = Array.isArray(firstArgs?.options)
    ? (firstArgs?.options as unknown[]).filter(
        (o): o is string => typeof o === "string",
      )
    : [];
  return {
    tool: actions[0].tool,
    question: actions[0].label,
    options,
    actions,
  };
}

/** 把仍在流的思考块收口（后端在思考之后的第一个事件处同样收口落库，两边语义一致）。 */
function sealReasoning(state: ChatState): ChatState {
  const last = state.items[state.items.length - 1];
  if (last?.kind !== "reasoning" || !last.streaming) return state;
  const items = state.items.slice();
  items[items.length - 1] = { ...last, streaming: false };
  return { ...state, items };
}

export function reduce(input: ChatState, ev: ChatEvent): ChatState {
  // 思考之后的第一个其它事件即代表这段思考结束
  const state = ev.type === "reasoning" ? input : sealReasoning(input);
  const id = () => `i${state.nextId}`;
  const bump = (items: ChatItem[]): ChatState => ({
    ...state,
    items,
    nextId: state.nextId + 1,
  });

  switch (ev.type) {
    case "reasoning": {
      const text = String(ev.payload.text ?? "");
      if (!text) return state;
      const last = state.items[state.items.length - 1];
      if (last?.kind === "reasoning" && last.streaming) {
        const items = state.items.slice();
        items[items.length - 1] = { ...last, text: last.text + text };
        return { ...state, items };
      }
      return bump([
        ...state.items,
        { id: id(), kind: "reasoning", text, streaming: true },
      ]);
    }
    case "token": {
      const text = String(ev.payload.text ?? "");
      if (!text) return state;
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        const items = state.items.slice();
        items[items.length - 1] = { ...last, text: last.text + text };
        return { ...state, items };
      }
      return bump([
        ...state.items,
        { id: id(), kind: "assistant", text, streaming: true },
      ]);
    }
    case "message": {
      const text = String(ev.payload.text ?? "");
      if (ev.role === "user") {
        return bump([...state.items, { id: id(), kind: "user", text }]);
      }
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        const items = state.items.slice();
        items[items.length - 1] = {
          ...last,
          text: text.length >= last.text.length ? text : last.text,
          streaming: false,
        };
        return { ...state, items };
      }
      if (!text) return state;
      // 防御性去重：与上一条已收口的助手气泡文本完全相同 → 跳过（后端已去重，这里兜底）
      if (last?.kind === "assistant" && !last.streaming && last.text === text) {
        return state;
      }
      return bump([
        ...state.items,
        { id: id(), kind: "assistant", text, streaming: false },
      ]);
    }
    case "tool_start": {
      const calls =
        (ev.payload.tool_calls as {
          name?: string;
          args?: Record<string, unknown>;
        }[]) ?? [];
      let s = state;
      for (const c of calls) {
        // write_todos 只由「任务计划」卡片呈现（plan_update），且它不发 tool_end 会永远转圈——
        // 不渲染成 tool 卡片，避免刷屏与假 loading。
        if (c.name === "write_todos") continue;
        // 防御性去重：与上一条工具卡片 name+args 完全相同 → 跳过（兜底 updates echo 的历史脏数据；
        // 后端已按 AIMessage id 去重，新数据不会重复）。
        const last = s.items[s.items.length - 1];
        if (
          last?.kind === "tool" &&
          last.name === (c.name ?? "tool") &&
          JSON.stringify(last.args ?? null) === JSON.stringify(c.args ?? null)
        ) {
          continue;
        }
        s = {
          ...s,
          items: [
            ...s.items,
            {
              id: `i${s.nextId}`,
              kind: "tool",
              name: c.name ?? "tool",
              done: false,
              args: c.args,
            },
          ],
          nextId: s.nextId + 1,
        };
      }
      return s;
    }
    case "tool_end": {
      const name = String(ev.payload.name ?? "");
      const content = ev.payload.content;
      const result =
        typeof content === "string" ? content : JSON.stringify(content ?? "");
      const items = state.items.slice();
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.name === name && !it.done) {
          items[i] = { ...it, done: true, result };
          break;
        }
      }
      return { ...state, items };
    }
    case "plan_update": {
      const todos =
        (ev.payload.todos as { content: string; status: string }[]) ?? [];
      const idx = state.items.findIndex((it) => it.kind === "plan");
      // 空列表 = 用户手动清空了计划（CanvasService.clearPlan 写的作废标记）：移除面板，
      // 不要留一张 0/0 的空计划卡。
      if (todos.length === 0) {
        if (idx === -1) return state;
        return { ...state, items: state.items.filter((_, i) => i !== idx) };
      }
      if (idx === -1) {
        return bump([...state.items, { id: id(), kind: "plan", todos }]);
      }
      const items = state.items.slice();
      items[idx] = { ...items[idx], kind: "plan", todos } as ChatItem;
      return { ...state, items };
    }
    case "control_request":
      return { ...state, status: "running", ask: extractAsk(ev.payload) };
    case "control_resolved":
      return { ...state, ask: null, status: "running" };
    case "result": {
      const items = state.items.map((it) =>
        it.kind === "tool" && !it.done ? { ...it, done: true } : it,
      );
      const status = ev.payload.status === "stopped" ? "done" : "done";
      return { ...state, items, status, ask: null };
    }
    case "error": {
      // 终止性事件：收尾未完成的工具卡片 + 清掉任何未决中断（ask），
      // 否则 chat.ask 残留会让前端 busy 永真、卡在"运行中"且无法恢复。
      const items = state.items.map((it) =>
        it.kind === "tool" && !it.done ? { ...it, done: true } : it,
      );
      return {
        ...bump([
          ...items,
          {
            id: id(),
            kind: "error",
            message: String(ev.payload.message ?? "Something went wrong"),
          },
        ]),
        status: "failed",
        ask: null,
      };
    }
    default:
      return state;
  }
}

/** 把 DB 历史消息折叠成基底状态。 */
export function buildBaseChat(messages: CanvasMessage[]): ChatState {
  let s = emptyChat;
  for (const m of messages) {
    const payload = (m.content ?? {}) as Record<string, unknown>;
    s = reduce(s, { type: m.type, role: m.role, payload });
  }
  // 历史里最后一条若是思考，没有后续事件替它收口 → 这里补一次，避免复原出永远转圈的思考块
  return sealReasoning(s);
}

export function foldChat(base: ChatState, events: ChatEvent[]): ChatState {
  return events.reduce(reduce, base);
}
