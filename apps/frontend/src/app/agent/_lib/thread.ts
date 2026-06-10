import type { Todo } from "@/components/agent/todo-list";
import type { Conversation, ConversationMessage } from "@/lib/api";

export type Decision = "approve" | "reject" | "edit" | "respond";

/** control_request 事件的 payload（deepagents HITL interrupt 值）。 */
export interface Approval {
  actionRequests: { name: string; args: unknown; description?: string }[];
  reviewConfigs: { actionName: string; allowedDecisions: string[] }[];
}

/** 对话区按顺序渲染的一条 thread item。 */
export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      result?: string;
      done: boolean;
    }
  | { kind: "plan"; id: string; todos: Todo[] }
  | { kind: "error"; id: string; text: string }
  // 生图/生视频卡片：由 generate_image/generate_video 的 tool_end 在工具 chip **之后**追加。
  // tool chip 本身保留（与 read_file 一样进工具组、参数可见），卡片只承载 generationId 锚点；
  // 卡片状态一律从 React Query（GET /conversations/:id/media）读。
  | { kind: "media"; id: string; generationId: string; mediaType: "image" | "video" };

/**
 * 归一事件：DB 历史 Message 与 socket ConversationEvent 都先转成这个形状，
 * 再喂给同一个 reduce 折叠，避免两套渲染逻辑。
 */
export interface NormalizedEvent {
  type: string; // message | token | tool_start | tool_end | plan_update | control_request | result | error
  payload: Record<string, unknown>;
  role?: string; // 仅 DB Message 带（user/assistant/tool）；socket 事件不带
}

export interface ThreadState {
  items: ThreadItem[];
  status: string;
  approval: Approval | null;
  nextId: number;
}

/** 工具结果可能是字符串或对象，统一转成可读文本（对象做缩进 JSON），避免渲染成 [object Object]。 */
function stringifyContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

const EMPTY: ThreadState = {
  items: [],
  status: "idle",
  approval: null,
  nextId: 0,
};

/** 纯函数：把一个归一事件折叠进当前 thread 状态。 */
export function reduce(state: ThreadState, ev: NormalizedEvent): ThreadState {
  const items = state.items.slice();
  const last = items[items.length - 1];
  let nextId = state.nextId;
  const id = () => `i${nextId++}`;

  switch (ev.type) {
    case "message": {
      const text = String(ev.payload?.text ?? "");
      if (!text) return state;
      if (ev.role === "user") {
        items.push({ kind: "user", id: id(), text });
      } else if (last?.kind === "assistant" && last.streaming) {
        // 之前流式 token 攒出的气泡，用这条完整文本收口。后端送来的 message 文本即累积 token，
        // 二者应一致；防御性地取较长者，绝不让收口把已显示内容缩短（曾因聚合文本更短而「变少」）。
        const finalText = text.length >= last.text.length ? text : last.text;
        items[items.length - 1] = { ...last, text: finalText, streaming: false };
      } else {
        items.push({ kind: "assistant", id: id(), text, streaming: false });
      }
      return { ...state, items, nextId };
    }
    case "token": {
      const text = String(ev.payload?.text ?? "");
      if (!text) return state;
      if (last?.kind === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: "assistant", id: id(), text, streaming: true });
      }
      return { ...state, items, nextId };
    }
    case "tool_start": {
      const calls =
        (ev.payload?.tool_calls as { name: string; args: unknown }[]) ?? [];
      for (const c of calls) {
        // write_todos 由 plan_update 的「任务计划」卡呈现，且 deepagents 用 Command 更新 state、
        // 不发 tool_end，渲染成 chip 会永远卡在「调用中」，故跳过。
        if (c.name === "write_todos") continue;
        items.push({ kind: "tool", id: id(), name: c.name, args: c.args, done: false });
      }
      return { ...state, items, nextId };
    }
    case "tool_end": {
      const name = ev.payload?.name;
      // 先按普通工具收尾：找到对应 chip 标记 done + 填结果（generate_* 也走这步——
      // chip 保留进工具组、参数可见，与 read_file 一致，推翻了早前「原位替换成 media」的决议）。
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.name === name && !it.done) {
          items[i] = { ...it, result: stringifyContent(ev.payload?.content), done: true };
          break;
        }
      }
      // 生图/生视频：LangChain 把工具返回值序列化为 JSON 字符串，content 形如
      // '{"generationId":"...","versionId":"...","status":"queued"}'。解析出 generationId 后，
      // 在工具 chip **之后**追加一条 kind:'media' 卡片锚点（不替换 chip）。
      const mediaType =
        name === "generate_image" ? "image" : name === "generate_video" ? "video" : null;
      if (mediaType) {
        let generationId: string | null = null;
        try {
          const parsed = JSON.parse(String(ev.payload?.content ?? ""));
          if (parsed && typeof parsed.generationId === "string") {
            generationId = parsed.generationId;
          }
        } catch {
          // 解析失败：仅保留上面的 chip 收尾，不追加卡片
        }
        // 防重复：同 generationId 的卡片只插一次。历史重放经 base 折叠出卡片后，若 live
        // tool_end 又携同一 generationId 抵达（foldLive 把 base+实时增量过同一 reducer），
        // 这里据已存在的 media item 去重，避免双卡。
        const exists =
          generationId != null &&
          items.some((it) => it.kind === "media" && it.generationId === generationId);
        if (generationId && !exists) {
          items.push({ kind: "media", id: id(), generationId, mediaType });
        }
      }
      return { ...state, items, nextId };
    }
    case "plan_update": {
      const todos = (ev.payload?.todos as Todo[]) ?? [];
      const idx = items.findIndex((it) => it.kind === "plan");
      if (idx >= 0) items[idx] = { kind: "plan", id: items[idx].id, todos };
      else items.push({ kind: "plan", id: id(), todos });
      return { ...state, items, nextId };
    }
    case "control_request": {
      return {
        ...state,
        status: "waiting_approval",
        approval: ev.payload as unknown as Approval,
      };
    }
    case "control_resolved": {
      // 仅前端乐观事件：提交审批决策后立即清掉卡片、恢复运行态
      return { ...state, status: "running", approval: null };
    }
    case "result": {
      // 运行结束：收尾仍挂着的工具 chip（有些工具不发 tool_end，或实时事件丢失）
      const settled = items.map((it) =>
        it.kind === "tool" && !it.done ? { ...it, done: true } : it,
      );
      return { ...state, items: settled, status: "done", approval: null };
    }
    case "error": {
      const text = String(ev.payload?.message ?? "");
      items.push({ kind: "error", id: id(), text });
      return { ...state, items, status: "failed", approval: null, nextId };
    }
    default:
      return state;
  }
}

function messageToEvent(m: ConversationMessage): NormalizedEvent {
  return {
    type: m.type,
    payload: (m.content ?? {}) as Record<string, unknown>,
    role: m.role,
  };
}

/**
 * 从 GET /conversations/:id 的结果建立基底状态：按 seq 折叠所有历史 message。
 * goal 已由后端落成 seq 0 的 user message，无需再单独预置（否则会重复渲染）。
 */
export function buildBaseState(conv: Conversation): ThreadState {
  let state: ThreadState = { ...EMPTY, status: conv.status };
  for (const m of conv.messages) {
    state = reduce(state, messageToEvent(m));
  }
  // 历史里没有 result 事件（未持久化）；会话已终态时收尾未完成的工具 chip，避免历史也卡「调用中」。
  // waiting_approval 不收尾——send_email 此时确实在等审批。
  if (conv.status === "done" || conv.status === "failed") {
    state = {
      ...state,
      items: state.items.map((it) =>
        it.kind === "tool" && !it.done ? { ...it, done: true } : it,
      ),
    };
  }
  return state;
}

/** 在基底之上折叠实时事件（订阅之后的增量）。 */
export function foldLive(
  base: ThreadState,
  events: NormalizedEvent[],
): ThreadState {
  return events.reduce(reduce, base);
}

export const emptyState = EMPTY;
