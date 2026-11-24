/**
 * 会话写过哪些工作区文件：工作区可能是所有会话共用的默认目录，也可能是用户自己的项目，
 * 删会话时不能整个目录删。这里在每次**写成功之后**记一笔——写之前文件不存在，就是本会话新建的。
 * （写失败的不记：edit_file 改一个不存在的路径、write_file 落盘失败，都没有产生文件。）
 * 写文件时顺带新建的各级父目录也记下来：删会话时文件移走、目录空了就收掉；用户原有的目录没有记录，不动。
 *
 * 归属规则（owned / ownedDirs）：本会话新建、且没有别的会话写过的。别的会话接着改过的文件不算，
 * 免得删掉这个会话把另一个会话正在用的文件带走。只是改过已有文件（用户项目里原有的源码等）也不算。
 * 命令行（execute）生成的文件不经过这里，没有记录。
 *
 * 路径存规范形式（realpath：解开软链、按磁盘上的实际大小写），同一个文件的不同写法才对得上——
 * macOS 默认不区分大小写，`readme.md` 与 `README.md` 是同一个文件。
 */
import { access, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/database';

const pathRow = z.object({ path: z.string() });

/** 写文件的地方只需要这一个口子（工具 / 导出里是可选的：没传就不记） */
export type FileRecorder = Pick<ConversationFiles, 'begin'>;

/** begin() 的结果：文件写成功之后调用，把这次写入记下来（不抛错） */
export type CommitWrite = () => Promise<void>;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * 包住一次「写一个文件」：write 成功后记一笔；write 抛错就不记，错误原样抛出。
 * absPath 用还没建目录时的路径也行（write 里再建目录）：这样新建的父目录也记得到。
 * 没传 files（测试、没接记录的调用方）就只写。
 */
export async function writeTracked<T>(
  files: FileRecorder | undefined,
  conversationId: string,
  absPath: string,
  write: () => Promise<T>,
): Promise<T> {
  if (!files) return write();
  const commit = await files.begin(conversationId, absPath);
  const out = await write();
  await commit();
  return out;
}

export class ConversationFiles {
  constructor(private readonly db: Db) {}

  /**
   * 写文件**之前**调用：看一眼文件和各级父目录在不在，返回「写成功之后记账」的函数（写失败就别调）。
   * 写之前不存在的文件 = 本会话新建；写之前不存在的父目录 = 这次写入顺带新建的。
   */
  async begin(conversationId: string, absPath: string): Promise<CommitWrite> {
    const existed = await exists(absPath);
    const newDirs: string[] = [];
    for (let dir = dirname(absPath); dirname(dir) !== dir && !(await exists(dir)); dir = dirname(dir)) newDirs.push(dir);
    return async () => {
      await this.record(conversationId, absPath, !existed, false);
      for (const dir of newDirs) await this.record(conversationId, dir, true, true);
    };
  }

  /**
   * 失败不抛：记账只是为了删会话时清产出，不能反过来让写文件失败。会话已不存在（运行收尾时被删）就不记。
   */
  private async record(conversationId: string, absPath: string, created: boolean, isDir: boolean): Promise<void> {
    try {
      const path = await realpath(absPath);
      // 同一会话再写：新建过就一直算新建（之后的修改不降级）
      this.db
        .prepare(
          `INSERT INTO conversation_file (conversation_id, path, created, is_dir, recorded_at)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM conversation WHERE id = ?)
           ON CONFLICT(conversation_id, path) DO UPDATE SET
             created = MAX(created, excluded.created), recorded_at = excluded.recorded_at`,
        )
        .run(conversationId, path, created ? 1 : 0, isDir ? 1 : 0, Date.now(), conversationId);
    } catch {
      // 文件转眼又没了（realpath 失败）或库暂时写不进：少记一笔，删会话时它留在原处
    }
  }

  /**
   * 归属于这个会话的文件：本会话新建、且没有别的会话写过（不管文件现在还在不在）。
   * alsoDeleting：同一批要一起删的会话——它们写过不算「别的会话还在用」，否则批量删除时
   * 共同写过的文件谁也不认领，留不留全看删除顺序。
   */
  owned(conversationId: string, alsoDeleting: readonly string[] = []): string[] {
    return this.ownedOf(conversationId, alsoDeleting, false);
  }

  /** 归属于这个会话的目录：它写文件时新建的（同样排除别的会话也新建过的） */
  ownedDirs(conversationId: string, alsoDeleting: readonly string[] = []): string[] {
    return this.ownedOf(conversationId, alsoDeleting, true);
  }

  private ownedOf(conversationId: string, alsoDeleting: readonly string[], dirs: boolean): string[] {
    return this.db
      .prepare(
        `SELECT f.path FROM conversation_file f
         WHERE f.conversation_id = ? AND f.created = 1 AND f.is_dir = ?
           AND NOT EXISTS (
             SELECT 1 FROM conversation_file o
             WHERE o.path = f.path AND o.conversation_id != f.conversation_id
               AND o.conversation_id NOT IN (SELECT value FROM json_each(?))
           )
         ORDER BY f.path`,
      )
      .all(conversationId, dirs ? 1 : 0, JSON.stringify(alsoDeleting))
      .map((r) => pathRow.parse(r).path);
  }
}
