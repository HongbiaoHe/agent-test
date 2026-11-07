/**
 * 剪辑工程的读写：video.read 载入（同时开始监听文件）、约 1 秒防抖自动保存（带 baseMtimeMs 做冲突检测）、
 * 撤销重做、外部修改静默重载 / 冲突提示；离开时把没写回的改动补写一次并 video.close。
 * 状态怎么变见 lib/document.ts（纯 reducer）。
 */
import type { VideoProject } from '@agent-test/video-schema';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { agent } from '@/lib/agent-client';
import { docReducer, initialDocState, isDirty } from '../lib/document';
import { saveStateOf } from '../lib/sync';

export const AUTOSAVE_DELAY_MS = 1000;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useVideoDocument(conversationId: string, path: string) {
  const [state, dispatch] = useReducer(docReducer, initialDocState);
  /** 写入在途：防止防抖保存与「导出前保存」并发写（两次写同一 baseMtimeMs，后一次必冲突） */
  const writingRef = useRef(false);
  /** 卸载时补写用：effect 里同步最新状态（不在渲染期写 ref） */
  const latestRef = useRef(state);
  useEffect(() => {
    latestRef.current = state;
  });

  const load = useCallback(async () => {
    try {
      const file = await agent.call('video.read', { conversationId, path });
      dispatch({ type: 'loaded', file });
    } catch (e) {
      dispatch({ type: 'loadFailed', error: messageOf(e) });
    }
  }, [conversationId, path]);

  /** 写回；baseMtimeMs 省略 = 强制覆盖。返回是否写成功 */
  const save = useCallback(
    async (project: VideoProject, version: number, baseMtimeMs: number | undefined): Promise<boolean> => {
      if (writingRef.current) return false;
      writingRef.current = true;
      dispatch({ type: 'saveStart' });
      try {
        const r = await agent.call('video.write', { conversationId, path, project, baseMtimeMs });
        if (r.ok) {
          dispatch({ type: 'saved', version, mtimeMs: r.mtimeMs });
          return true;
        }
        dispatch({ type: 'saveConflict', mtimeMs: r.mtimeMs });
        return false;
      } catch (e) {
        dispatch({ type: 'saveFailed', error: messageOf(e) });
        return false;
      } finally {
        writingRef.current = false;
      }
    },
    [conversationId, path],
  );

  // 打开：读文件（host 开始监听）；离开：没写回的改动补写一次（无冲突时），再停止监听
  useEffect(() => {
    void load();
    const latest = latestRef;
    return () => {
      const s = latest.current;
      if (s.history && s.editVersion !== s.savedVersion && !s.conflict) {
        void agent
          .call('video.write', { conversationId, path, project: s.history.present, baseMtimeMs: s.mtimeMs ?? undefined })
          .catch(() => undefined);
      }
      void agent.call('video.close', { conversationId, path }).catch(() => undefined);
    };
  }, [load, conversationId, path]);

  // 外部修改（agent 改了 JSON）；agent-host 重启后监听丢了：重读一次（重新监听），按 mtime 判断要不要重载
  useEffect(
    () =>
      agent.subscribe((e) => {
        if (e.kind === 'reconnected') {
          agent.call('video.read', { conversationId, path }).then(
            (file) => dispatch({ type: 'fileChanged', mtimeMs: file.mtimeMs }),
            () => undefined,
          );
          return;
        }
        if (e.type === 'video-file-changed' && e.conversationId === conversationId && e.path === path) {
          dispatch({ type: 'fileChanged', mtimeMs: e.mtimeMs });
        }
      }),
    [conversationId, path],
  );

  // 静默重载
  useEffect(() => {
    if (state.reloadToken > 0) void load();
  }, [state.reloadToken, load]);

  // 自动保存：最后一次编辑后约 1 秒写回；冲突未处理 / 上次写失败（等下一次编辑）时不自动写
  const present = state.history?.present ?? null;
  const pending =
    state.phase === 'ready' &&
    !state.saving &&
    !state.conflict &&
    !state.saveError &&
    state.editVersion !== state.savedVersion;
  useEffect(() => {
    if (!pending || !present) return;
    const version = state.editVersion;
    const base = state.mtimeMs ?? undefined;
    const timer = setTimeout(() => void save(present, version, base), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending, present, state.editVersion, state.mtimeMs, save]);

  const edit = useCallback((project: VideoProject | ((present: VideoProject) => VideoProject), key?: string) => {
    dispatch({ type: 'edit', project, key, at: Date.now() });
  }, []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  /** 导出前：有未写回的改动先写；有冲突返回 false（先让用户在提示条里选） */
  const flush = async (): Promise<boolean> => {
    if (state.conflict) return false;
    if (!present || state.editVersion === state.savedVersion) return true;
    return save(present, state.editVersion, state.mtimeMs ?? undefined);
  };

  return {
    phase: state.phase,
    error: state.error,
    issues: state.issues,
    project: present,
    canUndo: (state.history?.past.length ?? 0) > 0,
    canRedo: (state.history?.future.length ?? 0) > 0,
    saveState: saveStateOf({ saving: state.saving, editVersion: state.editVersion, savedVersion: state.savedVersion }),
    saveError: state.saveError,
    conflict: state.conflict,
    dirty: isDirty(state),
    edit,
    undo,
    redo,
    flush,
    /** 冲突提示「重新加载」：丢弃本地改动 */
    reload: () => void load(),
    /** 冲突提示「保留我的修改」：不带 baseMtimeMs 强制写入 */
    keepMine: () => {
      if (present) void save(present, state.editVersion, undefined);
    },
    retry: () => void load(),
  };
}

export type VideoDocument = ReturnType<typeof useVideoDocument>;
