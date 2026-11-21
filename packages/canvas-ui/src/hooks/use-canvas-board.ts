"use client";

import {
  applyPatch,
  type CanvasNodeType,
  type CanvasOpInput,
  type CanvasPatch,
  type CanvasRunLock,
  type CanvasSnapshot,
  type CanvasState,
} from "@agent-test/canvas-schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { CANVAS_MESSAGES } from "../i18n/messages";
import type { SaveState } from "../lib/save-state";
import type { CanvasLocale, CanvasUploadOptions } from "../platform";

/**
 * 画布编辑区的状态与用户操作（web / desktop 共用）：
 *  - 投影：快照作基底，canvas_patch 增量经 applyEvent 应用；
 *  - 用户结构编辑：串行提交、带最新 revision 做乐观并发，失败重拉快照；
 *  - 保存状态（左上角徽标）、拖线建节点、生成 / 拼接 / 暂停 / 继续 / 上传 / 圈定；
 *  - desktop 本机 agent 的运行锁：到点自动失效。
 * 宿主只提供「怎么调接口」（CanvasBoardSource）与快照；实时事件仍由宿主订阅，增量交给 applyEvent。
 */

/** 宿主的接口实现（web 走 REST，desktop 走 RPC → agent-host → Web 后端） */
export interface CanvasBoardSource {
  applyOp(
    op: CanvasOpInput,
    baseRevision: number,
  ): Promise<{ revision: number; patch: CanvasPatch }>;
  moveNode(nodeId: string, x: number, y: number): Promise<unknown>;
  generateNode(nodeId: string): Promise<unknown>;
  mergeVideo(nodeId: string): Promise<unknown>;
  /** 返回暂停了几个、几个已提交停不下来（拿不到就不提示） */
  pauseMedia(nodeId?: string): Promise<{ paused: number; skipped: number } | void>;
  resumeMedia(nodeId?: string): Promise<unknown>;
  /** 重发一次失败的生成（节点卡片上的 Retry） */
  retryMedia(generationId: string): Promise<unknown>;
  uploadNodeFile(
    nodeId: string,
    file: File,
    opts: CanvasUploadOptions,
  ): Promise<{ versionId: string }>;
  setFocus(nodeIds: string[]): Promise<unknown>;
  /** 快照过时了（生成状态变化、写入失败）：宿主重拉 */
  refresh(): void;
}

export interface UseCanvasBoardOptions {
  /** 画布 id；null = 没打开画布 */
  canvasId: string | null;
  /** 最新快照（宿主的查询结果）与它的更新时刻：更新时刻一变就按快照重铺投影 */
  snapshot: CanvasSnapshot | undefined;
  snapshotUpdatedAt: number;
  source: CanvasBoardSource;
  /** 提示语言（钩子可能在 CanvasPlatformProvider 之外调用，所以单独传） */
  locale: CanvasLocale;
}

const EMPTY_CANVAS: CanvasState = { nodes: [], edges: [], revision: 0 };
/** 稳定的空数组：每次渲染新建 [] 会让下游 memo/effect 白白失效 */
const EMPTY_FOCUS: string[] = [];
/** 终态自动消失延时（毫秒） */
const SAVED_LINGER_MS = 1500;
const ERROR_LINGER_MS = 3000;

const errorText = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

export function useCanvasBoard({
  canvasId,
  snapshot,
  snapshotUpdatedAt,
  source,
  locale,
}: UseCanvasBoardOptions) {
  const m = CANVAS_MESSAGES[locale].boardToast;

  // —— 画布投影：快照作基底（seed），patch 增量应用 ——
  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_CANVAS);
  const snapKey = `${canvasId ?? ""}:${snapshotUpdatedAt}`;
  const [trackedSnap, setTrackedSnap] = useState("");
  const [seededCanvasId, setSeededCanvasId] = useState<string | null>(null);
  /** 比本地旧、没拿来覆盖的那份快照（的 snapKey）：另拉一份新的 */
  const [staleSnap, setStaleSnap] = useState<string | null>(null);
  if (trackedSnap !== snapKey) {
    setTrackedSnap(snapKey);
    // 同一块画布上，快照比本地已应用的增量旧（重拉途中又来了增量）就不覆盖：
    // 典型是发起生成——服务端先推 media_update（触发重拉），随后回填节点的 update_node 增量才到；
    // 重拉读到的是回填前的库，晚于增量返回时会把「排队中 / 生成中」冲回「未生成」，
    // 而直到生成结束都不会再有通知（desktop 的两步是两次 HTTP 往返，最容易撞上）
    if (snapshot && seededCanvasId === canvasId && snapshot.revision < canvas.revision) {
      setStaleSnap(snapKey);
    } else {
      setSeededCanvasId(canvasId);
      setCanvas(
        snapshot
          ? { nodes: snapshot.nodes, edges: snapshot.edges, revision: snapshot.revision }
          : EMPTY_CANVAS,
      );
    }
  }

  // update_node 保存状态（按 nodeId）：inflight 计数聚合连续编辑，
  // 避免防抖多次提交时先返回的响应提前把 loading 清掉。
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const inflight = useRef<Record<string, number>>({});
  const clearTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // 最新已知 revision：CAS 基线。必须用 ref 而非闭包里的 canvas.revision——
  // 连续编辑（改完标题接着改正文）时 React 还没重渲染、增量也可能还没到，
  // 用旧 revision 发第二个 op 必然 409（实测表现为"保存失败"）。
  // 来源两处：本地 canvas 同步（含 patch/快照）+ applyOp 响应里的新 revision。
  const revisionRef = useRef(canvas.revision);
  useEffect(() => {
    revisionRef.current = Math.max(revisionRef.current, canvas.revision);
  }, [canvas.revision]);
  // 切画布时基线归零重新跟随（revision 是画布内计数，跨画布不可比）
  useEffect(() => {
    revisionRef.current = 0;
  }, [canvasId]);
  // 用户 op 串行队列：避免同一时刻多个 op 抢同一 revision 基线
  const opChain = useRef<Promise<unknown>>(Promise.resolve());
  // 卸载/切画布时清掉未到点的终态计时器
  useEffect(
    () => () => {
      for (const t of Object.values(clearTimers.current)) clearTimeout(t);
    },
    [],
  );

  // desktop 本机 agent 持有的运行锁（快照里的 runLock）。锁到点自动失效：
  // 到期时刻用计时器记下「这一份锁已过期」，不在渲染期读时钟（react-hooks/purity）
  const runLock = snapshot?.runLock ?? null;
  const [expiredLock, setExpiredLock] = useState<string | null>(null);
  useEffect(() => {
    if (!runLock) return;
    const expiresAt = runLock.expiresAt;
    const timer = setTimeout(
      () => setExpiredLock(expiresAt),
      Math.max(Date.parse(expiresAt) - Date.now(), 0),
    );
    return () => clearTimeout(timer);
  }, [runLock]);
  const activeLock: CanvasRunLock | null =
    runLock && expiredLock !== runLock.expiresAt ? runLock : null;

  /** 实时增量（宿主订阅到 canvas_patch 时调用）；引用稳定，可放进宿主订阅 effect 的依赖 */
  const applyEvent = useCallback((patch: CanvasPatch) => {
    setCanvas((prev) => applyPatch(prev, patch));
  }, []);

  // 宿主每次渲染给的 source / canvasId / 文案都可能是新对象：操作函数经 ref 读最新值，自身只建一次——
  // 引用稳定，宿主原样传给 FlowCanvas 时编辑区上下文不会每次渲染都换新，节点卡片不跟着白白重渲染
  // （对话侧栏里的画布：agent 每流式输出一个字，对话视图都会重渲染一次）
  const sourceRef = useRef(source);
  const canvasIdRef = useRef(canvasId);
  const mRef = useRef(m);
  useEffect(() => {
    sourceRef.current = source;
    canvasIdRef.current = canvasId;
    mRef.current = m;
  });

  // 丢掉了一份过时快照：再拉一份（增量已落库，新快照的 revision 不会再比本地旧），
  // 这样增量之外的变化（别的节点的生成状态等）也不会漏
  useEffect(() => {
    if (staleSnap) sourceRef.current.refresh();
  }, [staleSnap]);

  const actions = useMemo(() => {
    /**
     * 键入即进入 loading（防抖窗口内就显示，不等请求发出——"触发就开始"）。
     * 由编辑器在 onChange 时调用；随后的真实请求沿用同一 saving 态直到落终态。
     */
    function markSaving(nodeId: string) {
      const t = clearTimers.current[nodeId];
      if (t) {
        clearTimeout(t);
        delete clearTimers.current[nodeId];
      }
      setSaveStates((prev) =>
        prev[nodeId] === "saving" ? prev : { ...prev, [nodeId]: "saving" },
      );
    }

    /** 请求发起：在途计数 +1 并置 saving（内容编辑与位置移动共用）。 */
    function beginSave(nodeId: string) {
      inflight.current[nodeId] = (inflight.current[nodeId] ?? 0) + 1;
      markSaving(nodeId);
    }

    /** 撤销 loading：内容改回原值、最终没有 op 要发时调用（有在途请求则保持 saving）。 */
    function cancelSaving(nodeId: string) {
      if ((inflight.current[nodeId] ?? 0) > 0) return;
      setSaveStates((prev) => {
        if (!(nodeId in prev)) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    }

    /** 保存结账：仅当该节点无其他在途请求时落终态，并在 linger 后自动清除状态。 */
    function settleSave(nodeId: string, state: SaveState, linger: number) {
      inflight.current[nodeId] = Math.max((inflight.current[nodeId] ?? 1) - 1, 0);
      if (inflight.current[nodeId] > 0) return; // 还有后续编辑在途 → 保持 saving
      setSaveStates((prev) => ({ ...prev, [nodeId]: state }));
      clearTimers.current[nodeId] = setTimeout(() => {
        delete clearTimers.current[nodeId];
        setSaveStates((prev) => {
          const next = { ...prev };
          delete next[nodeId];
          return next;
        });
      }, linger);
    }

    /**
     * 节点位置变更（LWW）。本地先改，这里只落库。
     * 同样计入保存指示：拖完节点也要看到「保存中 → 已保存」（与内容编辑一致）。
     */
    function moveNode(nodeId: string, x: number, y: number) {
      if (!canvasIdRef.current) return;
      setCanvas((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)),
      }));
      beginSave(nodeId);
      void sourceRef.current
        .moveNode(nodeId, x, y)
        .then(() => settleSave(nodeId, "saved", SAVED_LINGER_MS))
        .catch(() => {
          sourceRef.current.refresh();
          settleSave(nodeId, "error", ERROR_LINGER_MS);
        });
    }

    /**
     * 保存状态的记账键。画布左上角的保存徽标是全局聚合的，键本身不需要对应仍然存在的节点
     * （删除后该键短暂停留在 saved 再自动清掉）。带 nodeId 的 op 按 nodeId 记；连线类 op
     * 没有 nodeId，按 op 名合成一个键（同名 op 并发由 inflight 计数聚合，不会互相顶掉）。
     */
    function saveKeyOf(op: CanvasOpInput): string | null {
      switch (op.op) {
        case "update_node":
        case "remove_node":
          return op.nodeId;
        case "add_node":
        case "add_edge":
        case "remove_edge":
          return `op:${op.op}`;
        default:
          return null;
      }
    }

    /** 用户结构编辑：带当前 revision 做乐观并发，失败（409 等）重拉快照。 */
    async function applyUserOp(op: CanvasOpInput) {
      await runUserOp(op);
    }

    /** applyUserOp 的内核：多回传一个 patch，供「新建节点后立刻接线」取服务端分配的 id。 */
    async function runUserOp(op: CanvasOpInput): Promise<CanvasPatch | null> {
      if (!canvasIdRef.current) return null;
      const key = saveKeyOf(op);
      // 键入时已 markSaving 点亮；这里补在途计数（beginSave 内含 markSaving，幂等）
      if (key) beginSave(key);
      // 串行执行：排在上一个 op 之后，保证取到的 revision 基线已被前一个响应更新
      const run = opChain.current.then(async () => {
        try {
          const res = await sourceRef.current.applyOp(op, revisionRef.current);
          revisionRef.current = res.revision; // 立即推进基线，无需等增量
          if (key) settleSave(key, "saved", SAVED_LINGER_MS);
          return res.patch;
        } catch {
          sourceRef.current.refresh();
          if (key) settleSave(key, "error", ERROR_LINGER_MS);
          return null;
        }
      });
      opChain.current = run;
      return run;
    }

    /**
     * 从某个节点的端口拖到空白处后，新建一个**已经接好线**的节点。
     * 分两步走而不是一个 op：add_node 的 id 由服务端分配，只有拿到返回的 patch 才知道
     * 该给谁接线。第一步失败（并发 409 等）就直接放弃，不留一个孤立的空节点。
     */
    async function addConnectedNode(input: {
      /** 拖拽起点节点。null = 不接线，就地建一个孤立节点（画布右键菜单） */
      fromId: string | null;
      /** 从出口拉出来 → 新节点在下游；从入口拉出来 → 新节点在上游 */
      direction: "downstream" | "upstream";
      type: CanvasNodeType;
      x: number;
      y: number;
    }): Promise<string | null> {
      const patch = await runUserOp({
        op: "add_node",
        type: input.type,
        x: input.x,
        y: input.y,
      });
      if (!patch || patch.op !== "add_node") return null;
      const created = patch.node.id;
      if (!input.fromId) return created;
      await runUserOp({
        op: "add_edge",
        source: input.direction === "downstream" ? input.fromId : created,
        target: input.direction === "downstream" ? created : input.fromId,
      });
      return created;
    }

    /**
     * 重发一次生成（节点上「Retry」用）：同一个 generation 叠一个新版本，提示词与参考图沿用上一版——
     * 失败重试要的就是"照原样再来一次"。状态不必手动改：生成状态变化会推 media_update，快照随之重拉。
     */
    function retryMedia(generationId: string) {
      void sourceRef.current
        .retryMedia(generationId)
        .then(() => sourceRef.current.refresh())
        .catch((e: unknown) => {
          toast.error(errorText(e, mRef.current.retryFailed));
        });
    }

    /**
     * 暂停 / 继续生成（不传 nodeId = 整张画布；传了 = 该节点及其下游）。
     * 已经提交给模型的停不下来（云端会跑完），提示一句免得以为没生效。
     */
    function pauseMedia(nodeId?: string) {
      if (!canvasIdRef.current) return;
      void sourceRef.current
        .pauseMedia(nodeId)
        .then((r) => {
          if (r && r.skipped > 0) {
            toast(r.paused > 0 ? mRef.current.pausedSome(r.paused, r.skipped) : mRef.current.cannotPause);
          }
          sourceRef.current.refresh();
        })
        .catch((e: unknown) => {
          toast.error(errorText(e, mRef.current.pauseFailed));
        });
    }

    function resumeMedia(nodeId?: string) {
      if (!canvasIdRef.current) return;
      void sourceRef.current
        .resumeMedia(nodeId)
        .then(() => sourceRef.current.refresh())
        .catch((e: unknown) => {
          toast.error(errorText(e, mRef.current.resumeFailed));
        });
    }

    /**
     * 用节点上选定的模型生成一次（生成节点面板上的 Generate）。提示词与参考图由服务端按入边收集
     * （与 agent 的 generate_media_node 同一段逻辑），所以这里只需要给出节点 id。
     */
    function generateNode(nodeId: string) {
      if (!canvasIdRef.current) return;
      beginSave(nodeId);
      void sourceRef.current
        .generateNode(nodeId)
        .then(() => {
          settleSave(nodeId, "saved", SAVED_LINGER_MS);
          sourceRef.current.refresh();
        })
        .catch((e: unknown) => {
          settleSave(nodeId, "error", ERROR_LINGER_MS);
          toast.error(errorText(e, mRef.current.generationFailed));
        });
    }

    /** 触发视频拼接（素材由服务端按入边顺序收集，与卡片预览顺序同源）。 */
    function mergeVideo(nodeId: string) {
      if (!canvasIdRef.current) return;
      beginSave(nodeId);
      void sourceRef.current
        .mergeVideo(nodeId)
        .then(() => {
          settleSave(nodeId, "saved", SAVED_LINGER_MS);
          sourceRef.current.refresh();
        })
        .catch((e: unknown) => {
          settleSave(nodeId, "error", ERROR_LINGER_MS);
          toast.error(errorText(e, mRef.current.mergeFailed));
        });
    }

    /**
     * 给上传节点传文件（卡片上的选择 / 拖入）。进度与失败由卡片自己显示；传完后端会广播
     * update_node 增量让节点出图，这里再刷一次快照兜底（增量漏了也不至于停在「没文件」）。
     */
    async function uploadNodeFile(
      nodeId: string,
      file: File,
      opts: CanvasUploadOptions,
    ): Promise<{ versionId: string }> {
      if (!canvasIdRef.current) throw new Error(mRef.current.notLoaded);
      const { versionId } = await sourceRef.current.uploadNodeFile(nodeId, file, opts);
      sourceRef.current.refresh();
      return { versionId };
    }

    /**
     * 「加入对话」：把选中的节点圈给 agent（传空数组 = 取消圈定）。画布级持续生效，
     * 服务端存在会话上，注入上下文时据此裁剪。成功后重拉快照，圈定标记跟着刷新。
     */
    function setFocus(nodeIds: string[]) {
      if (!canvasIdRef.current) return;
      void sourceRef.current
        .setFocus(nodeIds)
        .then(() => sourceRef.current.refresh())
        .catch((e: unknown) => {
          toast.error(errorText(e, mRef.current.focusFailed));
        });
    }

    return {
      /** 给 FlowCanvas 的 onApplyOp / onAddConnectedNode：不返回 Promise 的版本（失败已在内部收口） */
      applyOp: (op: CanvasOpInput) => void applyUserOp(op),
      addNode: (input: Parameters<typeof addConnectedNode>[0]) => void addConnectedNode(input),
      markSaving,
      cancelSaving,
      moveNode,
      applyUserOp,
      addConnectedNode,
      retryMedia,
      generateNode,
      mergeVideo,
      pauseMedia,
      resumeMedia,
      uploadNodeFile,
      setFocus,
    };
  }, []);

  return {
    canvas,
    /** canvas_patch 增量 */
    applyEvent,
    /** desktop 本机 agent 正持有的运行锁（已过期的不算）；null = 没有 */
    activeLock,
    /** 「加入对话」圈定的节点 id（空 = 关注整块画布） */
    focusNodeIds: snapshot?.focusNodeIds ?? EMPTY_FOCUS,
    saveStates,
    /** 以下操作引用稳定（见上方 actions） */
    ...actions,
  };

}

export type CanvasBoard = ReturnType<typeof useCanvasBoard>;
