"use client";

import {
  applyOps,
  type DesignDocument,
  type DesignOp,
  invertOps,
  type Layer,
  type OpSource,
} from "@agent-test/design-schema";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { designApi, type DesignRunStatus, type DesignSnapshot } from "./api";

/**
 * 编辑器状态（问题 3：服务端为准 + 字段级 op）。
 *
 * - 本地改动先乐观 applyOps，再**串行**提交（同一客户端的 op 保序到达服务端）；
 * - 服务端每批 op 都经 socket 广播 design_patch（含自己的回显）：自己的只推进 revision，
 *   别人的（agent / 生成流水线 / 另一个标签页）应用到本地；revision 出现断档就整份重拉快照；
 * - 撤销/重做只记**本端用户**的改动，存的是逆 op，撤销本身也是一次普通提交。
 */

export interface AgentFocus {
  layerIds: string[];
  action: string;
  at: number;
}

/** agent 正在某个图层上做的事（画板上一个绕着它转的光标）。 */
export interface AgentWork {
  action: string;
  at: number;
}

/** 光标绕图层一圈的时长：文字 / 调整类动作转完一圈就算做完 */
export const AGENT_ORBIT_MS = 1600;

/** 这一项还要不要显示：转完一圈之前都显示；图片还在生成 / 拆分就一直显示到结束。 */
export function isAgentWorkActive(
  layer: DesignDocument["layers"][number] | undefined,
  work: AgentWork,
  now: number,
): boolean {
  if (layer?.type === "image" && layer.status === "generating") return true;
  return now - work.at < AGENT_ORBIT_MS;
}

export interface EditorState {
  docId: string;
  title: string;
  doc: DesignDocument;
  revision: number;
  status: DesignRunStatus;
  selection: string[];
  /** agent 最近碰过的图层 → 时间戳（图层面板与画板据此做「刚被 agent 改过」的高亮） */
  agentTouched: Record<string, number>;
  /** agent 新加的图层 → 时间戳（显影动效只播一次） */
  agentAdded: Record<string, number>;
  /** agent 正在处理的图层 → 在做什么（可以同时好几个，每个画一个光标） */
  agentWork: Record<string, AgentWork>;
  focus: AgentFocus | null;
  canUndo: boolean;
  canRedo: boolean;
  /** 正在文字原地编辑的图层 */
  editingTextId: string | null;
}

interface HistoryEntry {
  forward: DesignOp[];
  inverse: DesignOp[];
}

const HISTORY_MAX = 100;

export function createClientId(): string {
  return `web_${Math.random().toString(36).slice(2, 10)}`;
}

export class DesignStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private needsResync = false;
  readonly clientId = createClientId();

  constructor(snap: DesignSnapshot) {
    this.state = {
      docId: snap.id,
      title: snap.title,
      doc: snap.document,
      revision: snap.revision,
      status: snap.status,
      selection: [],
      agentTouched: {},
      agentAdded: {},
      agentWork: {},
      focus: null,
      canUndo: false,
      canRedo: false,
      editingTextId: null,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private set(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  layer(id: string): Layer | undefined {
    return this.state.doc.layers.find((l) => l.id === id);
  }

  // ——— 选择 / 局部 UI 态 ———

  select(ids: string[]) {
    const valid = ids.filter((id) => this.layer(id));
    this.set({ selection: valid, editingTextId: null });
  }

  setEditingText(id: string | null) {
    this.set({ editingTextId: id });
  }

  setTitle(title: string) {
    this.set({ title });
  }

  // ——— 本端改动 ———

  /**
   * 乐观应用并提交。record=false 用于派生值（文字量高回写）：不进撤销栈。
   * 返回 false = 本地就不合法（不会提交）。
   */
  apply(ops: DesignOp[], opts: { record?: boolean } = {}): boolean {
    if (ops.length === 0) return true;
    const before = this.state.doc;
    let next: DesignDocument;
    try {
      next = applyOps(before, ops);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    }
    if (opts.record !== false) {
      this.undoStack.push({ forward: ops, inverse: invertOps(before, ops) });
      if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
      this.redoStack = [];
    }
    this.set({
      doc: next,
      selection: this.state.selection.filter((id) => next.layers.some((l) => l.id === id)),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    });
    this.submit(ops);
    return true;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (this.replay(entry.inverse)) this.redoStack.push(entry);
    this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    if (this.replay(entry.forward)) this.undoStack.push(entry);
    this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  /** 撤销/重做的应用：图层可能已被 agent 删掉，应用失败就丢掉这条历史。 */
  private replay(ops: DesignOp[]): boolean {
    try {
      const next = applyOps(this.state.doc, ops);
      this.set({ doc: next });
      this.submit(ops);
      return true;
    } catch {
      toast.message("这一步已无法撤销：相关图层已被修改或删除");
      return false;
    }
  }

  /** 等本端已提交的 op 全部落库（之后再调依赖它们的接口，如给刚加的图层发起生成）。 */
  flush(): Promise<void> {
    return this.queue;
  }

  private submit(ops: DesignOp[]) {
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        await designApi.applyOps(this.state.docId, ops, this.clientId);
      })
      .catch((e: unknown) => {
        // 服务端拒了（并发冲突 / 生成中锁定）：本地已偏离，回到服务端的版本
        toast.error(e instanceof Error ? e.message : String(e));
        this.needsResync = true;
      })
      .finally(() => {
        this.pending--;
        if (this.pending === 0 && this.needsResync) void this.resync();
      });
  }

  // ——— 服务端事件 ———

  onPatch(payload: { ops: DesignOp[]; revision: number; source: OpSource; clientId: string }) {
    const gap = payload.revision !== this.state.revision + 1;
    if (payload.clientId === this.clientId) {
      this.set({ revision: payload.revision });
      if (gap) this.scheduleResync();
      return;
    }
    let doc = this.state.doc;
    try {
      doc = applyOps(doc, payload.ops);
    } catch {
      this.scheduleResync();
    }
    const now = Date.now();
    const agentTouched = { ...this.state.agentTouched };
    const agentAdded = { ...this.state.agentAdded };
    if (payload.source === "agent") {
      for (const op of payload.ops) {
        const ids =
          op.type === "add_layers"
            ? op.layers.map((l) => l.id)
            : op.type === "update_layers"
              ? op.updates.map((u) => u.id)
              : [];
        ids.forEach((id) => (agentTouched[id] = now));
        if (op.type === "add_layers") op.layers.forEach((l) => (agentAdded[l.id] = now));
      }
    }
    this.set({
      doc,
      revision: payload.revision,
      agentTouched,
      agentAdded,
      selection: this.state.selection.filter((id) => doc.layers.some((l) => l.id === id)),
    });
    // 图片生成 / 拆层结束（或图层被删）时，它的光标随这次 patch 收起
    this.pruneWork();
    if (payload.source === "agent") {
      // 高亮是一次性的：显影动效 1.2s、「刚被 agent 改过」4s 后各自撤掉（时间戳没被更新才撤）
      setTimeout(() => this.expire("agentAdded", now), 1200);
      setTimeout(() => this.expire("agentTouched", now), 4000);
    }
    if (gap) this.scheduleResync();
  }

  private expire(key: "agentAdded" | "agentTouched", stamp: number) {
    const map = this.state[key];
    const kept = Object.fromEntries(Object.entries(map).filter(([, t]) => t !== stamp));
    if (Object.keys(kept).length === Object.keys(map).length) return;
    this.set(key === "agentAdded" ? { agentAdded: kept } : { agentTouched: kept });
  }

  onFocus(payload: { layerIds: string[]; action: string }) {
    const at = Date.now();
    const agentWork = { ...this.state.agentWork };
    for (const id of payload.layerIds) agentWork[id] = { action: payload.action, at };
    this.set({ focus: { ...payload, at }, agentWork });
    // 转完一圈收起（图片若已进入生成，pruneWork 会留着它）
    setTimeout(() => this.pruneWork(), AGENT_ORBIT_MS + 50);
  }

  private pruneWork() {
    const now = Date.now();
    const { doc, agentWork } = this.state;
    const kept = Object.fromEntries(
      Object.entries(agentWork).filter(([id, w]) =>
        isAgentWorkActive(
          doc.layers.find((l) => l.id === id),
          w,
          now,
        ),
      ),
    );
    if (Object.keys(kept).length !== Object.keys(agentWork).length) this.set({ agentWork: kept });
  }

  onStatus(status: DesignRunStatus) {
    this.set({ status, ...(status === "running" ? {} : { focus: null }) });
    // 一轮结束时对齐一次快照：乐观并发下的极少数字段冲突在这里收敛
    if (status !== "running") this.scheduleResync();
  }

  private scheduleResync() {
    this.needsResync = true;
    if (this.pending === 0) void this.resync();
  }

  async resync() {
    this.needsResync = false;
    try {
      const snap = await designApi.get(this.state.docId);
      if (this.pending > 0) {
        this.needsResync = true;
        return;
      }
      this.set({
        doc: snap.document,
        revision: snap.revision,
        status: snap.status,
        title: snap.title,
        selection: this.state.selection.filter((id) =>
          snap.document.layers.some((l) => l.id === id),
        ),
      });
      this.pruneWork();
    } catch {
      // 网络抖动：下一次事件或重连再对齐
    }
  }
}

export function useEditor<T>(store: DesignStore, selector: (s: EditorState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
