import type { Todo } from "@/components/agent/todo-list";
import type {
  Conversation,
  ConversationMessage,
  MediaGeneration,
  MediaStatus,
  MessageAttachment,
} from "@/lib/api";

export type Decision = "approve" | "reject" | "edit" | "respond";

/** control_request 事件的 payload（deepagents HITL interrupt 值）。 */
export interface Approval {
  actionRequests: { name: string; args: unknown; description?: string }[];
  reviewConfigs: { actionName: string; allowedDecisions: string[] }[];
}

/**
 * 对话区按顺序渲染的一条 thread item。
 * 时间字段一律是**服务端**毫秒时间戳（历史取 Message.createdAt，实时取 socket 事件 ts），
 * 刷新后从历史重建出同样的值；进行中的步骤用「服务端开始时间 → 本地 now」计时，刷新不归零。
 * 旧数据 / 乐观事件可能缺时间，此时不展示对应时间。
 */
export type ThreadItem =
  /** attachments：随这条消息上传的附件（老消息没有，为空数组）；at = 发送时间 */
  | {
      kind: "user";
      id: string;
      text: string;
      attachments: MessageAttachment[];
      at?: number;
    }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  /**
   * 模型思考过程（推理型模型才有）：流式累加，其后第一个其它事件到来即收口（streaming=false）。
   * sourceId = 产生这段思考的那条 AIMessage id —— 同一 id 的增量并进同一块；
   * 落库前没带 id 的旧行为空串，走「末尾那块」的合并规则。
   * startedAt = 上一个边界事件的时间（≈ 这次模型调用开始；Gemini 的思考在调用结束后才整块到达，
   * 不能拿首个增量当起点）；endedAt = 收口时间（思考之后的第一个事件，与后端落库时机一致）。
   */
  | {
      kind: "reasoning";
      id: string;
      sourceId: string;
      text: string;
      streaming: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: "tool";
      id: string;
      /** 后端 tool_call id（旧历史没有）：tool_start 合并、tool_end 配对都按它 */
      callId?: string;
      name: string;
      args: unknown;
      result?: string;
      done: boolean;
      /** tool_start 时间（审批续跑重发 tool_start 时更新为续跑时间，不把等审批算进执行耗时） */
      startedAt?: number;
      /** tool_end 时间；没有 tool_end、被 result 收尾的工具没有 */
      endedAt?: number;
    }
  | { kind: "plan"; id: string; todos: Todo[] }
  | { kind: "error"; id: string; text: string }
  // 生图/生视频卡片：由 generate_image/generate_video 的 tool_end 在工具 chip **之后**追加。
  // tool chip 本身保留（与 read_file 一样进工具组、参数可见），卡片只承载 generationId 锚点；
  // 卡片状态一律从 React Query（GET /conversations/:id/media）读。
  // 一次调用可批量生成（count>1）：同一次调用的 N 个生成位放进一个 item，渲染成一组网格。
  | { kind: "media"; id: string; generationIds: string[]; mediaType: "image" | "video" }
  // 网页预览卡片：agent 调 preview_page 成功后（tool_end）在工具 chip 之后追加，可再次打开预览。
  // 只存「预览什么」——预览地址带短期令牌/会话 id，打开时现签，不进 thread 状态。
  | { kind: "preview"; id: string; spec: PreviewSpec }
  // 一轮结束的总耗时（墙钟：用户发送 → result/error，含排队与等审批），由 result/error 追加
  | {
      kind: "turn";
      id: string;
      startedAt: number;
      endedAt: number;
      status: "done" | "stopped" | "failed";
    };

/**
 * 要预览什么：
 * - file：工作区里的静态 HTML，path 是工作区相对路径；
 * - port：沙箱里运行中的 web 服务（支持 vite HMR），path 是应用内路径。
 * 两种都经后端子域名反代（p-<id>.<基域名>），与主站不同源。
 */
export type PreviewSpec =
  | { kind: "file"; path: string; title: string }
  | { kind: "port"; port: number; path: string; title: string };

/**
 * 归一事件：DB 历史 Message 与 socket ConversationEvent 都先转成这个形状，
 * 再喂给同一个 reduce 折叠，避免两套渲染逻辑。
 */
export interface NormalizedEvent {
  type: string; // message | token | reasoning | tool_start | tool_end | plan_update | control_request | result | error
  payload: Record<string, unknown>;
  role?: string; // 仅 DB Message 带（user/assistant/tool）；socket 事件不带
  /** 服务端时间（ms）：DB 取 createdAt，socket 取 ts；乐观事件用本地时间或不带 */
  at?: number;
}

export interface ThreadState {
  items: ThreadItem[];
  status: string;
  approval: Approval | null;
  nextId: number;
  /** 上一个边界事件（token / reasoning 增量之外的事件）的时间：下一块思考的起点 */
  lastAt: number | null;
  /** 进行中这一轮的开始时间（用户消息时间）；轮结束清空 */
  turnStartedAt: number | null;
}

/**
 * 解析 preview_page 的工具结果（LangChain 把返回值序列化成 JSON 字符串）。
 * 只认成功形态 `{ status:'opened', path, port?, title }`：带 port 是端口预览，否则是静态页。
 * 文件不存在 / 端口没在监听等错误结果返回 null（不出卡片、不弹窗）。
 */
export function parsePreviewResult(content: unknown): PreviewSpec | null {
  try {
    const v: unknown = typeof content === "string" ? JSON.parse(content) : content;
    if (
      !v ||
      typeof v !== "object" ||
      !("status" in v) ||
      v.status !== "opened" ||
      !("path" in v) ||
      typeof v.path !== "string"
    ) {
      return null;
    }
    const title = "title" in v && typeof v.title === "string" ? v.title : v.path;
    if ("port" in v && typeof v.port === "number") {
      return { kind: "port", port: v.port, path: v.path, title };
    }
    return { kind: "file", path: v.path, title };
  } catch {
    // 非 JSON：不是成功结果
  }
  return null;
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
  lastAt: null,
  turnStartedAt: null,
};

/**
 * 把仍在流的思考块收口（后端在思考之后的第一个事件处同样收口落库，两边语义一致）。
 * 收**全部**而不只是末尾那块：按 sourceId 归集后，正在流的思考不一定还在队尾。
 */
function sealReasoning(state: ThreadState, at?: number): ThreadState {
  if (!state.items.some((it) => it.kind === "reasoning" && it.streaming)) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((it) =>
      it.kind === "reasoning" && it.streaming
        ? { ...it, streaming: false, endedAt: it.endedAt ?? at }
        : it,
    ),
  };
}

/**
 * 纯函数：把一个归一事件折叠进当前 thread 状态。
 * 顺带推进 lastAt：token / reasoning 增量不算边界（Gemini 的正文 token 先于思考到达，
 * 算进去会让思考起点变成「正文流完」）；与后端只在边界事件落库的口径一致，live 与刷新同值。
 */
export function reduce(input: ThreadState, ev: NormalizedEvent): ThreadState {
  const next = reduceEvent(input, ev);
  if (ev.at == null || ev.type === "token" || ev.type === "reasoning") return next;
  return { ...next, lastAt: ev.at };
}

function reduceEvent(input: ThreadState, ev: NormalizedEvent): ThreadState {
  // 思考之后的第一个其它事件即代表这段思考结束
  const state = ev.type === "reasoning" ? input : sealReasoning(input, ev.at);
  const items = state.items.slice();
  const last = items[items.length - 1];
  let nextId = state.nextId;
  const id = () => `i${nextId++}`;

  switch (ev.type) {
    case "reasoning": {
      const text = String(ev.payload?.text ?? "");
      if (!text) return state;
      // 按源消息归集：同一条 AIMessage 的多次增量并进同一块；没带 id 的只并进末尾正在流的那块
      const sourceId = String(ev.payload?.sourceId ?? "");
      const at = sourceId
        ? items.findIndex((it) => it.kind === "reasoning" && it.sourceId === sourceId)
        : last?.kind === "reasoning" && last.streaming
          ? items.length - 1
          : -1;
      const prev = at >= 0 ? items[at] : undefined;
      if (prev?.kind === "reasoning") {
        items[at] = { ...prev, text: prev.text + text };
      } else {
        // 历史行（带 role）本身就是收口后落的整块，createdAt 即收口时间；实时增量的块留空，
        // 等后继事件收口时再填（sealReasoning）。下一行的时间会晚于收口（如文本段落库），不能用它。
        const block: ThreadItem = {
          kind: "reasoning",
          id: id(),
          sourceId,
          text,
          streaming: true,
          startedAt: state.lastAt ?? ev.at,
          endedAt: ev.role != null ? ev.at : undefined,
        };
        // Gemini 的思考只能在模型调用结束后从 updates 整块拿到，此时同一条消息的正文已在流式渲染。
        // 思考属于那段正文之前（与落库 seq 顺序一致），插到正文前面；正文保持 streaming，
        // 随后的 message 事件才能照常收口它（否则会因末尾不是流式正文而再新建一条，正文重复）。
        if (last?.kind === "assistant" && last.streaming) {
          items.splice(items.length - 1, 0, block);
        } else {
          items.push(block);
        }
      }
      return { ...state, items, nextId };
    }
    case "message": {
      const text = String(ev.payload?.text ?? "");
      if (ev.role === "user") {
        // 只发附件的消息正文为空，照样成一条气泡
        const attachments = parseAttachments(ev.payload?.attachments);
        if (!text && attachments.length === 0) return state;
        items.push({ kind: "user", id: id(), text, attachments, at: ev.at });
        return { ...state, items, nextId, turnStartedAt: ev.at ?? null };
      }
      if (!text) return state;
      if (last?.kind === "assistant" && last.streaming) {
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
        (ev.payload?.tool_calls as { id?: string; name: string; args: unknown }[]) ?? [];
      for (const c of calls) {
        // write_todos 由 plan_update 的「任务计划」卡呈现，且 deepagents 用 Command 更新 state、
        // 不发 tool_end，渲染成 chip 会永远卡在「调用中」，故跳过。
        if (c.name === "write_todos") continue;
        // 审批（HITL）续跑时中间件会把同一个调用改写参数后再发一次 tool_start（id 不变）：
        // 合并进已有 chip、换成最终参数，而不是再插一个永远等不到 tool_end 的 chip
        const existing = c.id
          ? items.findIndex((it) => it.kind === "tool" && it.callId === c.id)
          : -1;
        if (existing >= 0) {
          const it = items[existing];
          if (it.kind === "tool") {
            items[existing] = { ...it, args: c.args, startedAt: ev.at ?? it.startedAt };
          }
          continue;
        }
        items.push({
          kind: "tool",
          id: id(),
          callId: c.id,
          name: c.name,
          args: c.args,
          done: false,
          startedAt: ev.at,
        });
      }
      return { ...state, items, nextId };
    }
    case "tool_end": {
      const name = ev.payload?.name;
      const callId = ev.payload?.toolCallId;
      // 先按普通工具收尾：找到对应 chip 标记 done + 填结果（generate_* 也走这步——
      // chip 保留进工具组、参数可见，与 read_file 一致，推翻了早前「原位替换成 media」的决议）。
      // 有 toolCallId 按它精确配对；旧历史没有，退回「同名、最近一个未完成」。
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        const match =
          typeof callId === "string" && it.kind === "tool" && it.callId
            ? it.callId === callId
            : it.kind === "tool" && it.name === name;
        if (match && it.kind === "tool" && !it.done) {
          items[i] = {
            ...it,
            result: stringifyContent(ev.payload?.content),
            done: true,
            endedAt: ev.at,
          };
          break;
        }
      }
      // 生图/生视频：解析工具返回的 generationId 列表（见 parseMediaGenerationIds），
      // 在工具 chip **之后**追加一条 kind:'media' 卡片锚点（不替换 chip）。
      // 参数校验失败（invalid_params）的结果没有 generations，只留 chip，错误在 chip 详情里可见。
      const mediaType =
        name === "generate_image" ? "image" : name === "generate_video" ? "video" : null;
      if (mediaType) {
        const generationIds = parseMediaGenerationIds(ev.payload?.content);
        // 防重复：同 generationId 的卡片只插一次。历史重放经 base 折叠出卡片后，若 live
        // tool_end 又携同一 generationId 抵达（foldLive 把 base+实时增量过同一 reducer），
        // 这里据已存在的 media item 去重，避免双卡。
        const exists = items.some(
          (it) => it.kind === "media" && it.generationIds.some((g) => generationIds.includes(g)),
        );
        if (generationIds.length > 0 && !exists) {
          items.push({ kind: "media", id: id(), generationIds, mediaType });
        }
      }
      if (name === "preview_page") {
        const spec = parsePreviewResult(ev.payload?.content);
        if (spec) items.push({ kind: "preview", id: id(), spec });
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
      const status = ev.payload?.status === "stopped" ? "stopped" : "done";
      pushTurn(settled, state.turnStartedAt, ev.at, status, id);
      return {
        ...state,
        items: settled,
        status: "done",
        approval: null,
        nextId,
        turnStartedAt: null,
      };
    }
    case "error": {
      const text = String(ev.payload?.message ?? "");
      items.push({ kind: "error", id: id(), text });
      pushTurn(items, state.turnStartedAt, ev.at, "failed", id);
      return {
        ...state,
        items,
        status: "failed",
        approval: null,
        nextId,
        turnStartedAt: null,
      };
    }
    default:
      return state;
  }
}

/** 轮结束：起止时间都在才追加总耗时条（旧数据 / 无对应用户消息的错误不出）。 */
function pushTurn(
  items: ThreadItem[],
  startedAt: number | null,
  endedAt: number | undefined,
  status: "done" | "stopped" | "failed",
  id: () => string,
) {
  if (startedAt == null || endedAt == null) return;
  items.push({ kind: "turn", id: id(), startedAt, endedAt, status });
}

function messageToEvent(m: ConversationMessage): NormalizedEvent {
  const at = Date.parse(m.createdAt);
  return {
    type: m.type,
    payload: (m.content ?? {}) as Record<string, unknown>,
    role: m.role,
    at: Number.isNaN(at) ? undefined : at,
  };
}

/** message.content.attachments 是后端落库的 Json，逐项用守卫收窄；形状不对的项丢掉。 */
function parseAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: MessageAttachment[] = [];
  for (const v of value) {
    if (typeof v !== "object" || v === null) continue;
    const { versionId, type, url, filename, contentType } = v as Record<string, unknown>;
    if (
      typeof versionId === "string" &&
      (type === "image" || type === "video" || type === "audio") &&
      typeof url === "string" &&
      typeof filename === "string"
    ) {
      out.push({
        versionId,
        type,
        url,
        filename,
        contentType: typeof contentType === "string" ? contentType : "",
      });
    }
  }
  return out;
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
  // 落库的思考都是收口后的完整块（后端在思考结束时才落一行），历史里不存在「还在流」的思考
  state = sealReasoning(state);
  // 审批/提问面板以服务端会话状态为准：决策只经 socket 提交、不落 messages 表，历史里 control_request
  // 之后要等到本轮 result 才会被清掉——答完后 agent 续跑期间刷新，会把已答过的问题再弹一次
  // （倒计时到点还会自动重提，后端 CAS 会拒，但面板本身就不该出现）。
  if (conv.status !== "waiting_approval") {
    state = { ...state, approval: null, status: conv.status };
  }
  // 会话已终态时收尾未完成的工具 chip，避免历史也卡「调用中」。
  // waiting_approval 不收尾——send_email 此时确实在等审批。
  if (
    conv.status === "done" ||
    conv.status === "failed" ||
    conv.status === "stopped"
  ) {
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

/**
 * 从 generate_image / generate_video 的工具返回（LangChain 序列化的 JSON 字符串）里取 generationId 列表。
 * 两种形状：现行 `{"status":"queued","generations":[{"generationId":…,"versionId":…}],…}`；
 * 旧会话历史里的 `{"generationId":…,"versionId":…,"status":"queued"}`。解析失败 / 校验失败返回 []。
 */
export function parseMediaGenerationIds(content: unknown): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(content ?? ""));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  if ("generations" in parsed && Array.isArray(parsed.generations)) {
    return parsed.generations.flatMap((g: unknown) =>
      typeof g === "object" && g !== null && "generationId" in g && typeof g.generationId === "string"
        ? [g.generationId]
        : [],
    );
  }
  if ("generationId" in parsed && typeof parsed.generationId === "string") {
    return [parsed.generationId];
  }
  return [];
}

const MEDIA_STATUSES: readonly MediaStatus[] = ["queued", "generating", "done", "failed", "cancelled"];

function isMediaStatus(v: unknown): v is MediaStatus {
  return typeof v === "string" && (MEDIA_STATUSES as readonly string[]).includes(v);
}

/**
 * 把一条 media_update（{ generationId, versionId, status, error? }）就地写进会话媒体列表。
 * 认不出的事件 / 列表里还没有的版本（刚建的生成位，等 refetch 补齐）原样返回。
 */
export function applyMediaUpdate(list: MediaGeneration[], payload: unknown): MediaGeneration[] {
  if (typeof payload !== "object" || payload === null) return list;
  if (!("versionId" in payload) || typeof payload.versionId !== "string") return list;
  if (!("status" in payload) || !isMediaStatus(payload.status)) return list;
  const { versionId, status } = payload;
  const error = "error" in payload && typeof payload.error === "string" ? payload.error : null;
  let hit = false;
  const next = list.map((g) => ({
    ...g,
    versions: g.versions.map((v) => {
      if (v.id !== versionId) return v;
      hit = true;
      return { ...v, status, error };
    }),
  }));
  return hit ? next : list;
}
