import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSqliteSaver } from '../db/checkpointer';
import { ConversationRepo } from '../db/conversations';
import { type Db, openDatabase } from '../db/database';
import { VideoSnapshots } from '../video/snapshots';
import { ConversationFiles, writeTracked } from './conversation-files';
import { StorageService } from './storage-service';

let dir: string;
let ws: string;
let db: Db;
let repo: ConversationRepo;
let files: ConversationFiles;
let snapshots: VideoSnapshots;
let storage: StorageService;
let running: Set<string>;
let stopped: string[];
let forgotten: string[];
let listChanges: number;
/** 废纸篓被调用时，这些会话行是否还在库里（应该已经不在） */
let rowsAliveAtTrash: boolean[];
/** 注入失败：停不下来的会话 / 清运行目录出错的会话 */
let failStop: Set<string>;
let failForget: Set<string>;

const runtimeRoot = () => join(dir, 'runtime');
const thumbsDir = () => join(dir, 'video-thumbs');
const trashDir = () => join(dir, 'trash');

beforeEach(async () => {
  // 规范路径（macOS 的临时目录在 /var → /private/var 软链后面）：记录里存的是 realpath
  dir = await realpath(await mkdtemp(join(tmpdir(), 'spark-storage-')));
  ws = join(dir, 'ws');
  await mkdir(ws, { recursive: true });
  await mkdir(trashDir());
  db = openDatabase(join(dir, 'spark.db'));
  repo = new ConversationRepo(db, () => ws);
  files = new ConversationFiles(db);
  snapshots = new VideoSnapshots(join(dir, 'video-snapshots'));
  const checkpointer = new NodeSqliteSaver(db);
  running = new Set();
  stopped = [];
  forgotten = [];
  listChanges = 0;
  rowsAliveAtTrash = [];
  failStop = new Set();
  failForget = new Set();
  storage = new StorageService({
    db,
    dbFile: join(dir, 'spark.db'),
    repo,
    files,
    checkpointer,
    snapshots,
    runtimeRoot: runtimeRoot(),
    thumbsDir: thumbsDir(),
    runs: {
      isRunning: (id) => running.has(id),
      stopAndWait: (id) => {
        if (failStop.has(id)) return Promise.reject(new Error('stop failed'));
        stopped.push(id);
        running.delete(id);
        return Promise.resolve();
      },
      forgetThread: async (id) => {
        if (failForget.has(id)) throw new Error('EACCES');
        await checkpointer.deleteThread(id);
        await rm(join(runtimeRoot(), id), { recursive: true, force: true });
      },
    },
    cancelBackground: () => undefined,
    forgetThumbnails: (p) => {
      forgotten.push(p);
      return Promise.resolve();
    },
    // 假废纸篓：移进测试目录；名字含 locked 的当作移不动
    trash: async (paths) => {
      rowsAliveAtTrash.push(stopped.some((id) => repo.get(id) !== null));
      const failed: string[] = [];
      for (const p of paths) {
        if (p.includes('locked')) failed.push(p);
        else await rename(p, join(trashDir(), basename(p)));
      }
      return failed;
    },
    listChanged: () => {
      listChanges++;
    },
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 模拟 agent 写文件：建好父目录并落盘，成功后记一笔（root：经哪条路径写，默认工作区本身） */
async function agentWrites(conversationId: string, rel: string, content = 'x', root = ws): Promise<string> {
  const abs = join(root, rel);
  await writeTracked(files, conversationId, abs, async () => {
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  });
  return abs;
}

function putCheckpoint(threadId: string, bytes: number): void {
  db.prepare(
    `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) VALUES (?, '', ?, 'json', ?, ?)`,
  ).run(threadId, `c-${bytes}`, new Uint8Array(bytes), new Uint8Array(0));
  db.prepare(
    `INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, '', ?, 't', 0, 'ch', 'json', ?)`,
  ).run(threadId, `c-${bytes}`, new Uint8Array(10));
}

/** 给会话铺满各类数据：消息、checkpoint、附件、技能副本、撤销快照 */
async function fill(id: string): Promise<void> {
  repo.appendMessage(id, 'user', 'message', { text: 'hello' });
  putCheckpoint(id, 1000);
  await mkdir(join(runtimeRoot(), id, 'attachments'), { recursive: true });
  await writeFile(join(runtimeRoot(), id, 'attachments', 'a.png'), new Uint8Array(300));
  await mkdir(join(runtimeRoot(), id, 'skills', 'demo'), { recursive: true });
  await writeFile(join(runtimeRoot(), id, 'skills', 'demo', 'SKILL.md'), new Uint8Array(200));
  await mkdir(join(snapshots.conversationDir(id), 'p'), { recursive: true });
  await writeFile(join(snapshots.conversationDir(id), 'p', '1.json'), new Uint8Array(50));
}

const count = (sql: string, ...args: string[]) => Number(db.prepare(sql).get(...args)?.n);

describe('ConversationFiles（会话写过的文件）', () => {
  it('写之前不存在 = 本会话新建；改已有文件不算；之后再改也不降级', async () => {
    const a = repo.create(null);
    await writeFile(join(ws, 'existing.ts'), 'user code');
    await agentWrites(a.id, 'existing.ts', 'edited');
    const created = await agentWrites(a.id, 'out/new.md');
    await agentWrites(a.id, 'out/new.md', 'second edit');
    expect(files.owned(a.id)).toEqual([created]);
  });

  it('别的会话也写过的文件不归任何一方；那个会话删掉后才归回来', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    const shared = await agentWrites(a.id, 'index.html');
    await agentWrites(b.id, 'index.html', 'b continues');
    expect(files.owned(a.id)).toEqual([]);
    expect(files.owned(b.id)).toEqual([]);
    repo.delete(b.id);
    expect(files.owned(a.id)).toEqual([shared]);
  });

  it('会话已被删掉（运行收尾时）就不记', async () => {
    const a = repo.create(null);
    repo.delete(a.id);
    await agentWrites(a.id, 'late.txt');
    expect(count('SELECT COUNT(*) AS n FROM conversation_file')).toBe(0);
  });

  it('写失败不记：之后别人在同一路径建的文件不会被算成这个会话的', async () => {
    const a = repo.create(null);
    const abs = join(ws, 'config.ts');
    await expect(writeTracked(files, a.id, abs, () => Promise.reject(new Error('write failed')))).rejects.toThrow('write failed');
    await writeFile(abs, 'user wrote this later');
    expect(files.owned(a.id)).toEqual([]);
  });

  it('同一个文件的不同写法（经软链目录、大小写不同）认得出是同一个', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    const viaLink = join(dir, 'ws-link');
    await symlink(ws, viaLink);
    const created = await agentWrites(a.id, 'readme.md');
    await agentWrites(b.id, 'readme.md', 'b via symlink', viaLink);
    expect(files.owned(a.id)).toEqual([]);
    repo.delete(b.id);
    expect(files.owned(a.id)).toEqual([created]);

    // 文件系统不区分大小写时（macOS 默认）：README.md 就是 readme.md
    if (existsSync(join(ws, 'README.md'))) {
      const c = repo.create(null);
      await agentWrites(c.id, 'README.md', 'c uses another case');
      expect(files.owned(a.id)).toEqual([]);
    }
  });

  it('批量删除：一起删的会话共同写过的文件归新建它的那个，不看删除顺序', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    const shared = await agentWrites(a.id, 'index.html');
    await agentWrites(b.id, 'index.html', 'b continues');
    expect(files.owned(a.id)).toEqual([]);
    expect(files.owned(a.id, [a.id, b.id])).toEqual([shared]);
    expect(files.owned(b.id, [a.id, b.id])).toEqual([]);
  });
});

describe('StorageService.deleteConversations', () => {
  it('删会话：库里的行、checkpoint、运行目录、撤销快照全清；它新建的产出进废纸篓，别的不动', async () => {
    const a = repo.create(null);
    const other = repo.create(null);
    await fill(a.id);
    await fill(other.id);
    await writeFile(join(ws, 'existing.ts'), 'user code');
    await agentWrites(a.id, 'existing.ts', 'edited by a');
    const video = await agentWrites(a.id, 'media/v1/clip.mp4');
    await agentWrites(a.id, 'shared.md');
    await agentWrites(other.id, 'shared.md', 'other continues');
    const otherOwn = await agentWrites(other.id, 'other.md');
    running.add(a.id);

    const res = await storage.deleteConversations([a.id]);

    expect(res).toEqual({ deleted: [a.id], trashedFiles: 1, failedFiles: [] });
    expect(stopped).toEqual([a.id]);
    expect(repo.get(a.id)).toBeNull();
    for (const table of ['message', 'conversation_file']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE conversation_id = ?`, a.id)).toBe(0);
    }
    for (const table of ['checkpoints', 'writes']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = ?`, a.id)).toBe(0);
    }
    expect(existsSync(join(runtimeRoot(), a.id))).toBe(false);
    expect(existsSync(snapshots.conversationDir(a.id))).toBe(false);
    // 产出：新建的视频进了废纸篓，留下的空目录 media/v1、media 也收掉；预览帧缓存一并清
    expect(await readdir(trashDir())).toEqual(['clip.mp4']);
    expect(existsSync(join(ws, 'media'))).toBe(false);
    expect(forgotten).toEqual([video]);
    // 只是改过的已有文件、另一个会话也写过的文件：原样保留
    expect(existsSync(join(ws, 'existing.ts'))).toBe(true);
    expect(existsSync(join(ws, 'shared.md'))).toBe(true);
    // 另一个会话毫发无损
    expect(repo.messages(other.id)).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?', other.id)).toBe(1);
    expect(existsSync(join(runtimeRoot(), other.id, 'attachments', 'a.png'))).toBe(true);
    expect(existsSync(snapshots.conversationDir(other.id))).toBe(true);
    expect(existsSync(otherOwn)).toBe(true);
  });

  it('记录的路径不在这个会话的工作区里（或已经是目录 / 不存在）就不碰', async () => {
    const a = repo.create(null);
    const outside = await agentWrites(a.id, 'outside.txt', 'not in workspace', dir);
    const gone = await agentWrites(a.id, 'gone.txt');
    await rm(gone);
    // 记录时是文件、现在同名位置是个目录
    const swapped = await agentWrites(a.id, 'swapped');
    await rm(swapped);
    await mkdir(swapped);
    const res = await storage.deleteConversations([a.id]);
    expect(res.trashedFiles).toBe(0);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(swapped)).toBe(true);
  });

  it('只收会话自己建的目录：用户原有的空目录、里面还有别人文件的目录都留着', async () => {
    const a = repo.create(null);
    // 用户项目里原有的空目录：agent 往里写了文件
    await mkdir(join(ws, 'output'));
    await agentWrites(a.id, 'output/a.txt');
    // 会话自己建的两级目录
    await agentWrites(a.id, 'gen/deep/b.txt');
    // 会话自己建的目录，但用户后来往里放了自己的文件
    await agentWrites(a.id, 'mixed/c.txt');
    await writeFile(join(ws, 'mixed', 'mine.txt'), 'user file');

    const res = await storage.deleteConversations([a.id]);

    expect(res.trashedFiles).toBe(3);
    expect(existsSync(join(ws, 'output'))).toBe(true);
    expect(await readdir(join(ws, 'output'))).toEqual([]);
    expect(existsSync(join(ws, 'gen'))).toBe(false);
    expect(await readdir(join(ws, 'mixed'))).toEqual(['mine.txt']);
    expect(existsSync(ws)).toBe(true);
  });

  it('移不进废纸篓的文件留在原处并报告，会话照样删掉；不存在的 id 跳过', async () => {
    const a = repo.create(null);
    const locked = await agentWrites(a.id, 'locked.bin');
    const res = await storage.deleteConversations([a.id, 'no-such-id']);
    expect(res).toEqual({ deleted: [a.id], trashedFiles: 0, failedFiles: [locked] });
    expect(existsSync(locked)).toBe(true);
    expect(repo.get(a.id)).toBeNull();
  });
});

describe('StorageService.deleteConversations：顺序与出错', () => {
  it('全选删除：两个会话共同写过的文件，不管先删谁都进废纸篓', async () => {
    for (const order of ['a-first', 'b-first'] as const) {
      const a = repo.create(null);
      const b = repo.create(null);
      const name = `shared-${order}.html`;
      await agentWrites(a.id, name);
      await agentWrites(b.id, name, 'b continues');
      const res = await storage.deleteConversations(order === 'a-first' ? [a.id, b.id] : [b.id, a.id]);
      expect(res.deleted).toHaveLength(2);
      expect(res.trashedFiles).toBe(1);
      expect(existsSync(join(ws, name))).toBe(false);
    }
  });

  it('先删库里的会话行，再做文件清理：清理途中这个会话已经不可能被重新开跑', async () => {
    const a = repo.create(null);
    await agentWrites(a.id, 'out.txt');
    await storage.deleteConversations([a.id]);
    expect(rowsAliveAtTrash).toEqual([false]);
  });

  it('清理某一步出错：会话照样算删掉、侧栏照样刷新，这一批里别的会话不受影响', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    await fill(a.id);
    await fill(b.id);
    failForget.add(a.id);
    const res = await storage.deleteConversations([a.id, b.id]);
    expect(res.deleted).toEqual([a.id, b.id]);
    expect(repo.list()).toEqual([]);
    expect(listChanges).toBe(1);
    // a 的运行目录没清掉：成了「已删会话的残留」，存储页可以再清
    expect((await storage.scan()).shared.orphans.bytes).toBeGreaterThan(0);
    expect(existsSync(join(runtimeRoot(), b.id))).toBe(false);
  });

  it('某个会话停不下来：它留着并报错，其它的照删，侧栏照样刷新', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    failStop.add(a.id);
    await expect(storage.deleteConversations([a.id, b.id])).rejects.toThrow('stop failed');
    expect(repo.list().map((c) => c.id)).toEqual([a.id]);
    expect(listChanges).toBe(1);
  });
});

describe('StorageService.scan / clearCache', () => {
  it('按会话、按分类给出占用；共享缓存与已删会话的残留单列', async () => {
    const a = repo.create(null);
    const empty = repo.create(null);
    await fill(a.id);
    await agentWrites(a.id, 'out.txt', 'x'.repeat(70));
    await mkdir(thumbsDir(), { recursive: true });
    await writeFile(join(thumbsDir(), 'k.jpg'), new Uint8Array(400));
    await mkdir(join(runtimeRoot(), 'deleted-conv', 'attachments'), { recursive: true });
    await writeFile(join(runtimeRoot(), 'deleted-conv', 'attachments', 'old.bin'), new Uint8Array(90));

    const report = await storage.scan();

    // 占用大的排前面
    expect(report.conversations.map((c) => c.id)).toEqual([a.id, empty.id]);
    const u = report.conversations[0].usage;
    expect(u.messages).toEqual({ bytes: JSON.stringify({ text: 'hello' }).length, count: 1 });
    expect(u.checkpoints).toEqual({ bytes: 1010, count: 1 });
    expect(u.attachments).toEqual({ bytes: 300, count: 1 });
    expect(u.skills).toEqual({ bytes: 200, count: 1 });
    expect(u.snapshots).toEqual({ bytes: 50, count: 1 });
    expect(u.outputs).toEqual({ bytes: 70, count: 1 });
    expect(report.conversations[0].cacheBytes).toBe(1010 + 200 + 50);
    expect(report.conversations[0].totalBytes).toBe(u.messages.bytes + 1010 + 300 + 200 + 50 + 70);
    expect(report.conversations[1].totalBytes).toBe(0);
    expect(report.shared).toEqual({ thumbnails: { bytes: 400, count: 1 }, orphans: { bytes: 90, count: 1 } });
    // 主文件 + WAL：刚写入的数据还在 WAL 里也算得到
    expect(report.databaseBytes).toBeGreaterThan(statSync(join(dir, 'spark.db')).size);
  });

  it('清所选会话的缓存：只动缓存分类，消息 / 附件 / 产出留着；别的会话不动', async () => {
    const a = repo.create(null);
    const b = repo.create(null);
    await fill(a.id);
    await fill(b.id);
    const out = await agentWrites(a.id, 'out.txt');

    const res = await storage.clearCache({ conversationIds: [a.id], categories: ['checkpoints', 'skills', 'snapshots'] });

    expect(res).toEqual({ freedBytes: 1010 + 200 + 50, skipped: [] });
    const after = await storage.scan();
    const ua = after.conversations.find((c) => c.id === a.id)?.usage;
    expect(ua?.checkpoints.bytes).toBe(0);
    expect(ua?.skills.bytes).toBe(0);
    expect(ua?.snapshots.bytes).toBe(0);
    expect(ua?.messages.count).toBe(1);
    expect(ua?.attachments.bytes).toBe(300);
    expect(existsSync(out)).toBe(true);
    expect(after.conversations.find((c) => c.id === b.id)?.cacheBytes).toBe(1010 + 200 + 50);
  });

  it('只清一个分类；正在运行 / 停在审批上的会话跳过', async () => {
    const idle = repo.create(null);
    const waiting = repo.create(null);
    const active = repo.create(null);
    for (const c of [idle, waiting, active]) await fill(c.id);
    repo.setStatus(waiting.id, 'waiting_approval');
    running.add(active.id);

    const res = await storage.clearCache({ categories: ['checkpoints'] });

    expect(res.freedBytes).toBe(1010);
    expect(res.skipped.sort()).toEqual([waiting.id, active.id].sort());
    expect(count('SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?', idle.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?', waiting.id)).toBe(1);
    // 没选的分类不动
    expect(existsSync(join(runtimeRoot(), idle.id, 'skills'))).toBe(true);
  });

  it('清共享缓存：预览帧、已删会话的残留目录', async () => {
    const a = repo.create(null);
    await fill(a.id);
    await mkdir(thumbsDir(), { recursive: true });
    await writeFile(join(thumbsDir(), 'k.jpg'), new Uint8Array(400));
    await mkdir(join(runtimeRoot(), 'deleted-conv'), { recursive: true });
    await writeFile(join(runtimeRoot(), 'deleted-conv', 'old.bin'), new Uint8Array(90));
    await mkdir(join(snapshots.conversationDir('deleted-conv'), 'p'), { recursive: true });
    await writeFile(join(snapshots.conversationDir('deleted-conv'), 'p', '1.json'), new Uint8Array(10));

    const res = await storage.clearCache({ categories: [], sharedCategories: ['thumbnails', 'orphans'] });

    expect(res.freedBytes).toBe(400 + 100);
    expect(await readdir(thumbsDir())).toEqual([]);
    expect(existsSync(join(runtimeRoot(), 'deleted-conv'))).toBe(false);
    expect(existsSync(snapshots.conversationDir('deleted-conv'))).toBe(false);
    // 还在的会话不受影响
    expect(existsSync(join(runtimeRoot(), a.id, 'attachments', 'a.png'))).toBe(true);
    expect(existsSync(snapshots.conversationDir(a.id))).toBe(true);
  });
});
