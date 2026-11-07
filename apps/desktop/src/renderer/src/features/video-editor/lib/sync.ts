/**
 * 文件同步的判定（纯函数，单测见 sync.test.ts）：收到 video-file-changed 时，
 * 这是自己刚写入触发的、外部修改（可以静默重载），还是外部修改撞上了本地没写回的改动（冲突提示）。
 */

export type FileChangeAction =
  /** 自己写入（或读到的）那一版，或比它更旧的过期事件：忽略 */
  | 'ignore'
  /** 正在写入：写完拿到新 mtime 再判定（事件可能比写入的响应先到） */
  | 'defer'
  /** 外部修改、本地没有未写回的改动：静默重新加载 */
  | 'reload'
  /** 外部修改、本地有未写回的改动：提示「重新加载 / 保留我的修改」 */
  | 'conflict';

export function classifyFileChange(input: {
  /** 事件里的文件 mtime */
  mtimeMs: number;
  /** 最近一次读取 / 自己写入成功后拿到的 mtime；还没读到为 null */
  knownMtimeMs: number | null;
  /** 有写入请求在途 */
  writing: boolean;
  /** 本地有未写回的改动（防抖中 / 写失败 / 冲突未处理） */
  dirty: boolean;
}): FileChangeAction {
  if (input.writing) return 'defer';
  if (input.knownMtimeMs !== null && input.mtimeMs <= input.knownMtimeMs) return 'ignore';
  return input.dirty ? 'conflict' : 'reload';
}

/** 保存状态显示：写入在途 → 保存中；有没写回的编辑 → 未保存；否则已保存 */
export type SaveState = 'saved' | 'saving' | 'unsaved';

export function saveStateOf(input: { saving: boolean; editVersion: number; savedVersion: number }): SaveState {
  if (input.saving) return 'saving';
  return input.editVersion === input.savedVersion ? 'saved' : 'unsaved';
}
