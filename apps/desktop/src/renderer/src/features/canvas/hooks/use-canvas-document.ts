/**
 * desktop 画布视图的数据：快照（canvas.snapshot）+ 实时事件（agent-host 转发的 canvas 事件）+
 * 编辑区的状态与用户操作（canvas-ui 的 useCanvasBoard，与 Web 画布同一份逻辑）。
 * 接口经 RPC 由 agent-host 代为调用 Web 后端；规则（运行期只读、revision 冲突）由服务端执行。
 */
import { isCanvasBusy, runLockFromEvent, type CanvasPatch, type CanvasSnapshot } from '@agent-test/canvas-schema';
import { useCanvasBoard, type CanvasBoardSource, type CanvasLocale } from '@agent-test/canvas-ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { agent } from '@/lib/agent-client';
import { i18n } from '@/lib/i18n';
import { CANVAS_INLINE_UPLOAD_MAX_BYTES } from '../../../../../shared/canvas';
import { canvasSnapshotKey } from '../lib/query-keys';

/**
 * 上传节点的文件来源：拖入 / 选择的本机文件给路径（host 流式读盘转发，不经 MessagePort 搬字节）；
 * 拿不到路径的（剪贴板图片等）才读成字节，且限大小
 */
async function uploadSource(
  file: File,
): Promise<{ kind: 'path'; path: string } | { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> }> {
  const path = window.desktop.getPathForFile(file);
  if (path) return { kind: 'path', path };
  if (file.size > CANVAS_INLINE_UPLOAD_MAX_BYTES) throw new Error(i18n.t('canvas.view.uploadTooLarge'));
  return { kind: 'bytes', bytes: new Uint8Array(await file.arrayBuffer()) };
}

export function useCanvasDocument(canvasId: string, locale: CanvasLocale) {
  const qc = useQueryClient();
  const key = canvasSnapshotKey(canvasId);
  const snapQ = useQuery({
    queryKey: key,
    queryFn: () => agent.call('canvas.snapshot', { id: canvasId }),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const source: CanvasBoardSource = {
    applyOp: (op, baseRevision) => agent.call('canvas.applyOp', { id: canvasId, op, baseRevision }),
    moveNode: (nodeId, x, y) => agent.call('canvas.move', { id: canvasId, nodeId, x, y }),
    generateNode: (nodeId) => agent.call('canvas.generate', { id: canvasId, nodeId }),
    mergeVideo: (nodeId) => agent.call('canvas.merge', { id: canvasId, nodeId }),
    pauseMedia: (nodeId) => agent.call('canvas.pauseMedia', { id: canvasId, nodeId }),
    resumeMedia: (nodeId) => agent.call('canvas.resumeMedia', { id: canvasId, nodeId }),
    retryMedia: (generationId) => agent.call('media.regenerate', { generationId }),
    uploadNodeFile: async (nodeId, file, opts) => {
      opts.onProgress?.(0);
      const r = await agent.call('canvas.uploadNodeFile', {
        id: canvasId,
        nodeId,
        source: await uploadSource(file),
        contentType: file.type || 'application/octet-stream',
        filename: file.name,
      });
      opts.onProgress?.(1);
      return { versionId: r.versionId };
    },
    setFocus: (nodeIds) => agent.call('canvas.setFocus', { id: canvasId, nodeIds }),
    refresh,
  };
  const board = useCanvasBoard({
    canvasId,
    snapshot: snapQ.data,
    snapshotUpdatedAt: snapQ.dataUpdatedAt,
    source,
    locale,
  });

  // 视图打开期间让 agent-host 转发这块画布的实时事件：增量直接应用，其余（锁、生成状态、
  // Web 画布 agent 跑完、断线重连）重拉快照
  const applyEvent = board.applyEvent;
  useEffect(() => {
    void agent.call('canvas.watch', { id: canvasId }).catch(() => undefined);
    const unsub = agent.subscribe((e) => {
      if (e.kind === 'reconnected') {
        // agent-host 重启：转发要重新开，快照也可能过时
        void agent.call('canvas.watch', { id: canvasId }).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: canvasSnapshotKey(canvasId) });
        return;
      }
      if (e.type !== 'canvas' || e.canvasId !== canvasId) return;
      if (e.event.type === 'canvas_patch' && isPatch(e.event.payload)) {
        applyEvent(e.event.payload);
        return;
      }
      if (e.event.type === 'canvas_lock') {
        // 运行锁直接写进缓存快照（不重拉）：锁先于 agent 的第一个增量到达，画布立刻进入
        // 「agent 在操作」（只读 + 自动聚焦新节点）。更新时刻沿用原值——它一变，编辑区会按这份
        // （可能较旧的）快照重铺，冲掉之后到达的增量
        const runLock = runLockFromEvent(e.event.payload);
        if (runLock === undefined) return;
        const key = canvasSnapshotKey(canvasId);
        qc.setQueryData<CanvasSnapshot>(key, (prev) => (prev ? { ...prev, runLock } : prev), {
          updatedAt: qc.getQueryState(key)?.dataUpdatedAt,
        });
        return;
      }
      void qc.invalidateQueries({ queryKey: canvasSnapshotKey(canvasId) });
    });
    return () => {
      unsub();
      void agent.call('canvas.unwatch', { id: canvasId }).catch(() => undefined);
    };
  }, [canvasId, qc, applyEvent]);

  const snapshot = snapQ.data;
  // 服务端画布 agent 在跑，或（本机 / 别的）desktop agent 持有有效的运行锁：只能拖位置
  const serverAgentRunning = snapshot ? isCanvasBusy({ status: snapshot.status, runLock: null }) : false;
  return {
    board,
    snapshot,
    isLoading: snapQ.isLoading,
    error: snapQ.error,
    retry: () => void snapQ.refetch(),
    serverAgentRunning,
    readOnly: serverAgentRunning || board.activeLock !== null,
  };
}

/** canvas_patch 的 payload：服务端广播的 CanvasPatch（我方后端的事件，只确认带 op 字段） */
function isPatch(v: unknown): v is CanvasPatch {
  return typeof v === 'object' && v !== null && 'op' in v && typeof v.op === 'string';
}
