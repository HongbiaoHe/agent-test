/**
 * 剪辑器的文档状态机（纯 reducer，单测见 document.test.ts）：载入 / 编辑（撤销栈）/ 自动保存 / 外部修改与冲突。
 * 副作用（读写 RPC、防抖定时器、事件订阅）在 use-video-document.ts，这里只管状态怎么变。
 */
import type { VideoProject } from '@agent-test/video-schema';
import type { VideoProjectFile } from '../../../../../shared/rpc';
import { createHistory, type History, pushHistory, redoHistory, undoHistory } from './history';
import { classifyFileChange } from './sync';

/** 同一字段连续改动（拖滑块、连续打字）在这个间隔内合并成一步撤销 */
export const COALESCE_MS = 1000;

export interface DocState {
  phase: 'loading' | 'ready' | 'invalid' | 'error';
  /** phase=error：读文件失败的原因 */
  error: string | null;
  /** phase=invalid：校验问题 */
  issues: string[];
  history: History<VideoProject> | null;
  /** 磁盘上我们所知的版本（读取 / 自己写入成功后的 mtime）：写回时作 baseMtimeMs，也用来认出自己的写入 */
  mtimeMs: number | null;
  /** 每次本地编辑（含撤销重做）+1；savedVersion = 已写回的那一版 */
  editVersion: number;
  savedVersion: number;
  saving: boolean;
  saveError: string | null;
  /** external = 外部修改撞上本地未写回的改动；write = 写回时发现磁盘已被改（baseMtimeMs 不符） */
  conflict: 'external' | 'write' | null;
  /** 写入在途时收到的外部修改：写完再判 */
  deferredMtimeMs: number | null;
  /** 需要静默重新加载时 +1（effect 据此去读文件） */
  reloadToken: number;
  lastEdit: { key: string; at: number } | null;
}

export type DocAction =
  | { type: 'loaded'; file: VideoProjectFile }
  | { type: 'loadFailed'; error: string }
  /** project 可以是函数：基于最新的 present 计算（异步操作回来后编辑，不用闭包里过期的工程） */
  | { type: 'edit'; project: VideoProject | ((present: VideoProject) => VideoProject); key?: string; at: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saveStart' }
  | { type: 'saved'; version: number; mtimeMs: number }
  | { type: 'saveConflict'; mtimeMs: number }
  | { type: 'saveFailed'; error: string }
  | { type: 'fileChanged'; mtimeMs: number };

export const initialDocState: DocState = {
  phase: 'loading',
  error: null,
  issues: [],
  history: null,
  mtimeMs: null,
  editVersion: 0,
  savedVersion: 0,
  saving: false,
  saveError: null,
  conflict: null,
  deferredMtimeMs: null,
  reloadToken: 0,
  lastEdit: null,
};

export const isDirty = (s: DocState) => s.editVersion !== s.savedVersion || s.conflict !== null;

function applyFileChange(s: DocState, mtimeMs: number): DocState {
  switch (classifyFileChange({ mtimeMs, knownMtimeMs: s.mtimeMs, writing: s.saving, dirty: isDirty(s) })) {
    case 'ignore':
      return s;
    case 'defer':
      return { ...s, deferredMtimeMs: Math.max(s.deferredMtimeMs ?? 0, mtimeMs) };
    case 'reload':
      return { ...s, reloadToken: s.reloadToken + 1 };
    case 'conflict':
      return { ...s, conflict: 'external' };
  }
}

/** 写入结束：处理写入期间缓下来的外部修改 */
function settleDeferred(s: DocState): DocState {
  const deferred = s.deferredMtimeMs;
  const next = { ...s, deferredMtimeMs: null };
  return deferred === null ? next : applyFileChange(next, deferred);
}

export function docReducer(s: DocState, a: DocAction): DocState {
  switch (a.type) {
    case 'loaded':
      return {
        ...initialDocState,
        phase: a.file.project ? 'ready' : 'invalid',
        issues: a.file.issues,
        history: a.file.project ? createHistory(a.file.project) : null,
        mtimeMs: a.file.mtimeMs,
        reloadToken: s.reloadToken,
      };
    case 'loadFailed':
      return { ...s, phase: s.history ? s.phase : 'error', error: a.error };
    case 'edit': {
      if (!s.history) return s;
      const project = typeof a.project === 'function' ? a.project(s.history.present) : a.project;
      if (project === s.history.present) return s;
      const coalesce = !!a.key && s.lastEdit?.key === a.key && a.at - s.lastEdit.at < COALESCE_MS;
      return {
        ...s,
        history: pushHistory(s.history, project, { coalesce }),
        editVersion: s.editVersion + 1,
        saveError: null,
        lastEdit: a.key ? { key: a.key, at: a.at } : null,
      };
    }
    case 'undo':
    case 'redo': {
      if (!s.history) return s;
      const history = a.type === 'undo' ? undoHistory(s.history) : redoHistory(s.history);
      if (history === s.history) return s;
      return { ...s, history, editVersion: s.editVersion + 1, saveError: null, lastEdit: null };
    }
    case 'saveStart':
      return { ...s, saving: true };
    case 'saved':
      return settleDeferred({
        ...s,
        saving: false,
        savedVersion: a.version,
        mtimeMs: a.mtimeMs,
        saveError: null,
        conflict: null,
      });
    case 'saveConflict':
      // 不更新 mtimeMs：之后外部修改事件照常判成冲突；「保留我的修改」不带 baseMtimeMs 强写
      return { ...s, saving: false, conflict: 'write', deferredMtimeMs: null };
    case 'saveFailed':
      return settleDeferred({ ...s, saving: false, saveError: a.error });
    case 'fileChanged':
      return applyFileChange(s, a.mtimeMs);
  }
}
