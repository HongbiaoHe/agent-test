/**
 * 存储占用与清理（设置 → 存储；删除会话也走这里）。
 *
 * 一个会话在本机留下的东西：
 * - 库里的行：消息 / token 用量 / 审批 / 后台任务 / 写过的文件记录（随 conversation 行级联删除）；
 * - checkpoint（只有停在审批上时才有，见 RunService）；
 * - 运行目录 `<runtime>/<会话 id>/`：attachments/（附件副本）+ skills/（每轮同步的技能副本）；
 * - 剪辑撤销快照 `<video-snapshots>/<会话 id>/`；
 * - 工作区里它新建的产出文件（见 conversation-files.ts 的归属规则）——删会话时移进系统废纸篓，不直接删。
 * 不在本机的不归这里管：Web 账号下的生成记录与 CDN 文件保留在账号里。
 *
 * 缓存 = 清掉不影响对话内容、之后会按需重建的部分（checkpoint / 技能副本 / 撤销快照 / 预览帧）。
 * 正在运行或停在审批上的会话，缓存正被使用，清缓存时跳过。
 */
import { lstat, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ConversationSummary } from '../../shared/rpc';
import {
  CACHE_CATEGORIES,
  type CacheCategory,
  type ClearCacheResult,
  type ConversationStorage,
  type DeleteConversationsResult,
  type SharedCacheCategory,
  STORAGE_CATEGORIES,
  type StorageCategory,
  type StorageReport,
  type StorageUsage,
} from '../../shared/storage';
import type { NodeSqliteSaver } from '../db/checkpointer';
import type { ConversationRepo } from '../db/conversations';
import { type Db, reclaimFreeSpace } from '../db/database';
import type { VideoSnapshots } from '../video/snapshots';
import type { ConversationFiles } from './conversation-files';

export interface StorageDeps {
  db: Db;
  /** 数据库文件路径（报告里给出文件大小） */
  dbFile: string;
  repo: ConversationRepo;
  files: ConversationFiles;
  checkpointer: NodeSqliteSaver;
  snapshots: VideoSnapshots;
  /** 各会话运行目录的父目录 */
  runtimeRoot: string;
  /** 视频预览帧缓存目录（按素材路径缓存，不分会话） */
  thumbsDir: string;
  runs: {
    isRunning(conversationId: string): boolean;
    stopAndWait(conversationId: string): Promise<void>;
    forgetThread(conversationId: string): Promise<void>;
  };
  /** 取消这个会话的后台任务 */
  cancelBackground: (conversationId: string) => void;
  /** 素材被删后清掉它的预览帧缓存 */
  forgetThumbnails: (absPath: string) => Promise<void>;
  /** 把文件移进系统废纸篓（main 进程的 shell.trashItem）；返回没移成功的路径 */
  trash: (paths: string[]) => Promise<string[]>;
  listChanged: () => void;
  log?: (msg: string) => void;
}

const usageRow = z.object({ id: z.string(), bytes: z.number().nullable(), n: z.number() });
const EMPTY: StorageUsage = { bytes: 0, count: 0 };

/** 目录里所有普通文件的总大小与个数（不跟软链；目录不存在 = 0） */
async function dirUsage(dir: string): Promise<StorageUsage> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  let count = 0;
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirUsage(p);
      bytes += sub.bytes;
      count += sub.count;
    } else if (e.isFile()) {
      bytes += (await stat(p).catch(() => null))?.size ?? 0;
      count++;
    }
  }
  return { bytes, count };
}

function add(a: StorageUsage, b: StorageUsage): StorageUsage {
  return { bytes: a.bytes + b.bytes, count: a.count + b.count };
}

/** root 之内（不含 root 本身）的路径 */
function isInside(root: string, path: string): boolean {
  return resolve(path).startsWith(resolve(root) + sep);
}

export class StorageService {
  constructor(private readonly deps: StorageDeps) {}

  // ── 扫描 ─────────────────────────────────────────────────────────────────

  async scan(): Promise<StorageReport> {
    const { db, repo, snapshots, runtimeRoot, thumbsDir } = this.deps;
    const byId = (sql: string): Map<string, StorageUsage> =>
      new Map(
        db
          .prepare(sql)
          .all()
          .map((r) => usageRow.parse(r))
          .map((r) => [r.id, { bytes: r.bytes ?? 0, count: r.n }]),
      );
    // 文本列按字节算（LENGTH 对 TEXT 返回字符数）
    const messages = byId(
      'SELECT conversation_id AS id, SUM(LENGTH(CAST(content AS BLOB))) AS bytes, COUNT(*) AS n FROM message GROUP BY conversation_id',
    );
    const checkpoints = byId(
      'SELECT thread_id AS id, SUM(LENGTH(checkpoint) + LENGTH(metadata)) AS bytes, COUNT(*) AS n FROM checkpoints GROUP BY thread_id',
    );
    const writes = byId('SELECT thread_id AS id, SUM(LENGTH(value)) AS bytes, 0 AS n FROM writes GROUP BY thread_id');

    const list = repo.list();
    const conversations: ConversationStorage[] = [];
    for (const c of list) {
      const runtime = join(runtimeRoot, c.id);
      const usage: Record<StorageCategory, StorageUsage> = {
        messages: messages.get(c.id) ?? EMPTY,
        attachments: await dirUsage(join(runtime, 'attachments')),
        outputs: await this.outputsUsage(c),
        checkpoints: add(checkpoints.get(c.id) ?? EMPTY, writes.get(c.id) ?? EMPTY),
        skills: await dirUsage(join(runtime, 'skills')),
        snapshots: await dirUsage(snapshots.conversationDir(c.id)),
      };
      conversations.push({
        id: c.id,
        title: c.title,
        goal: c.goal,
        status: c.status,
        updatedAt: c.updatedAt,
        busy: this.isBusy(c),
        usage,
        totalBytes: STORAGE_CATEGORIES.reduce((sum, k) => sum + usage[k].bytes, 0),
        cacheBytes: CACHE_CATEGORIES.reduce((sum, k) => sum + usage[k].bytes, 0),
      });
    }
    conversations.sort((a, b) => b.totalBytes - a.totalBytes || b.updatedAt - a.updatedAt);

    let orphans = EMPTY;
    for (const dir of await this.orphanDirs(new Set(list.map((c) => c.id)))) orphans = add(orphans, await dirUsage(dir));
    const shared: Record<SharedCacheCategory, StorageUsage> = { thumbnails: await dirUsage(thumbsDir), orphans };
    // WAL 模式下新写入的数据先在 -wal 文件里，合并进主文件之前主文件可能很小：两个一起算
    let databaseBytes = 0;
    for (const f of [this.deps.dbFile, `${this.deps.dbFile}-wal`]) databaseBytes += (await stat(f).catch(() => null))?.size ?? 0;
    return { conversations, shared, databaseBytes, scannedAt: Date.now() };
  }

  // ── 清缓存 ───────────────────────────────────────────────────────────────

  /**
   * 清掉给定会话（不给 = 全部会话）的缓存分类；sharedCategories 是不分会话的缓存。
   * 正在运行 / 停在审批上的会话跳过（记在 skipped 里）。
   */
  async clearCache(input: {
    conversationIds?: readonly string[];
    categories: readonly CacheCategory[];
    sharedCategories?: readonly SharedCacheCategory[];
  }): Promise<ClearCacheResult> {
    const { checkpointer, snapshots, runtimeRoot, thumbsDir, repo } = this.deps;
    const before = await this.scan();
    const wanted = input.conversationIds ? new Set(input.conversationIds) : null;
    let freedBytes = 0;
    const skipped: string[] = [];
    for (const c of before.conversations) {
      if (wanted && !wanted.has(c.id)) continue;
      // 扫描之后状态可能变了：按现在的状态判断
      const now = repo.get(c.id);
      if (!now) continue;
      if (this.isBusy(now)) {
        skipped.push(c.id);
        continue;
      }
      for (const category of input.categories) {
        if (category === 'checkpoints') await checkpointer.deleteThread(c.id);
        else if (category === 'skills') await rm(join(runtimeRoot, c.id, 'skills'), { recursive: true, force: true });
        else await rm(snapshots.conversationDir(c.id), { recursive: true, force: true });
        freedBytes += c.usage[category].bytes;
      }
    }
    for (const category of input.sharedCategories ?? []) {
      if (category === 'thumbnails') {
        for (const name of await readdir(thumbsDir).catch(() => [])) await rm(join(thumbsDir, name), { recursive: true, force: true });
      } else {
        for (const dir of await this.orphanDirs(new Set(repo.list().map((c) => c.id)))) {
          await rm(dir, { recursive: true, force: true });
        }
      }
      freedBytes += before.shared[category].bytes;
    }
    this.reclaim();
    return { freedBytes, skipped };
  }

  // ── 删会话 ───────────────────────────────────────────────────────────────

  /** 删除会话，连同它在本机的全部数据、缓存与它新建的产出文件（产出文件移进废纸篓） */
  async deleteConversations(ids: readonly string[]): Promise<DeleteConversationsResult> {
    const result: DeleteConversationsResult = { deleted: [], trashedFiles: 0, failedFiles: [] };
    let firstError: Error | null = null;
    try {
      for (const id of ids) {
        const conv = this.deps.repo.get(id);
        if (!conv) continue;
        // 一个会话删不掉（停不下来等）不拖累这一批里其它的：记下第一个错误，最后再抛
        try {
          const { trashed, failed } = await this.deleteOne(conv, ids);
          result.deleted.push(id);
          result.trashedFiles += trashed;
          result.failedFiles.push(...failed);
        } catch (e) {
          firstError ??= e instanceof Error ? e : new Error(String(e));
          this.deps.log?.(`删除会话失败 conversation=${id}: ${String(e)}`);
        }
      }
    } finally {
      // 中途出错也要让侧栏知道已经删掉的那些
      if (result.deleted.length) {
        this.reclaim();
        this.deps.listChanged();
      }
    }
    if (firstError) throw firstError;
    return result;
  }

  /** batch：这一批一起删的会话 id（算文件归属时它们不算「别的会话还在用」） */
  private async deleteOne(
    conv: ConversationSummary,
    batch: readonly string[],
  ): Promise<{ trashed: number; failed: string[] }> {
    const { repo, runs, snapshots, files } = this.deps;
    // 先让正在跑的那一轮彻底收尾：否则它还会往已删的会话里写消息、重建运行目录
    await runs.stopAndWait(conv.id);
    this.deps.cancelBackground(conv.id);
    // 归属要在删库行之前读（记录随会话行级联删除）。从这里到 repo.delete 之间没有 await：
    // 会话行一没，就不可能再有新的一轮在清理途中开跑
    const owned = files.owned(conv.id, batch);
    const ownedDirs = files.ownedDirs(conv.id, batch);
    repo.delete(conv.id);

    // 之后的清理各自尽力而为：某一步失败只留下残留（存储页的「已删会话的残留」可清），不影响别的步骤
    let trashed = 0;
    let failed: string[] = [];
    await this.attempt(conv.id, async () => {
      // 工作区目录已经不在了：没有产出可清
      const root = await realpath(conv.workspaceDir).catch(() => null);
      if (!root) return;
      const outputs = await this.existingFiles(root, owned);
      failed = outputs.length ? await this.deps.trash(outputs) : [];
      const gone = outputs.filter((p) => !failed.includes(p));
      trashed = gone.length;
      for (const p of gone) await this.deps.forgetThumbnails(p);
      await this.removeEmptyDirs(root, ownedDirs);
    });
    await this.attempt(conv.id, () => runs.forgetThread(conv.id));
    await this.attempt(conv.id, () => rm(snapshots.conversationDir(conv.id), { recursive: true, force: true }));
    return { trashed, failed };
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private isBusy(c: ConversationSummary): boolean {
    return c.status === 'running' || c.status === 'waiting_approval' || this.deps.runs.isRunning(c.id);
  }

  private async attempt(conversationId: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (e) {
      this.deps.log?.(`清理会话数据时出错 conversation=${conversationId}: ${String(e)}`);
    }
  }

  /** 整理数据库把空闲页还给文件系统；失败只记日志（数据已经删了，文件晚点再缩不影响正确性） */
  private reclaim(): void {
    try {
      reclaimFreeSpace(this.deps.db);
    } catch (e) {
      this.deps.log?.(`数据库整理失败：${String(e)}`);
    }
  }

  /** paths 里现在还在、且确实在工作区（root：规范路径）里的普通文件 */
  private async existingFiles(root: string, paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) {
      if (!isInside(root, p)) continue;
      const st = await lstat(p).catch(() => null);
      if (st?.isFile()) out.push(p);
    }
    return out;
  }

  private async outputsUsage(conv: ConversationSummary): Promise<StorageUsage> {
    // 工作区目录已经不在了：没有产出可算
    const root = await realpath(conv.workspaceDir).catch(() => null);
    if (!root) return EMPTY;
    let bytes = 0;
    const paths = await this.existingFiles(root, this.deps.files.owned(conv.id));
    for (const p of paths) bytes += (await stat(p).catch(() => null))?.size ?? 0;
    return { bytes, count: paths.length };
  }

  /**
   * 会话写文件时自己建的目录（如 media/<versionId>/）：文件移走后空了就删，由深到浅。
   * 非空（别人往里放了东西、有文件没移走）rmdir 会失败，留着；用户原有的目录不在 dirs 里，不会碰
   */
  private async removeEmptyDirs(root: string, dirs: readonly string[]): Promise<void> {
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      if (isInside(root, dir)) await rmdir(dir).catch(() => undefined);
    }
  }

  /** 运行目录 / 快照目录里已经没有对应会话的子目录 */
  private async orphanDirs(alive: ReadonlySet<string>): Promise<string[]> {
    const { runtimeRoot, snapshots } = this.deps;
    const out: string[] = [];
    for (const e of await readdir(runtimeRoot, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !alive.has(e.name)) out.push(join(runtimeRoot, e.name));
    }
    for (const id of await snapshots.conversationIds()) {
      if (!alive.has(id)) out.push(snapshots.conversationDir(id));
    }
    return out;
  }
}
