/**
 * LangGraph checkpointer 的 node:sqlite 实现，用于审批 / ask_user 中断后的续跑（重启应用也能接着审批）。
 *
 * 移植自 @langchain/langgraph-checkpoint-sqlite 1.1.0 的 SqliteSaver（MIT）。没直接用那个包：它依赖
 * better-sqlite3，而 better-sqlite3 12 编不过 Electron 45 的 V8（2026-11-05 实测）。改动：
 * - better-sqlite3 → node:sqlite（prepare/get/all/run 同名；transaction()/pragma() 换成手写 SQL）；
 * - pending writes 直接按 (task_path, task_id, idx) 排序：当前 @langchain/langgraph-checkpoint 1.0.2
 *   还没有上游用的 writesSortKey / compareWritesSortKeys；
 * - 去掉 v<4 旧 checkpoint 的 pending sends 迁移（本库从零创建，不存在旧格式）；
 * - 不支持 list 的 metadata filter（RunService 不用 list）。
 */
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  copyCheckpoint,
  type PendingWrite,
  WRITES_IDX_MAP,
} from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import { type Db, transaction } from './database';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`;

const SELECT = `
SELECT
  thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata,
  (
    SELECT json_group_array(json_object(
      'task_id', pw.task_id, 'channel', pw.channel, 'type', pw.type,
      'value', CAST(pw.value AS TEXT), 'task_path', pw.task_path, 'idx', pw.idx))
    FROM writes AS pw
    WHERE pw.thread_id = checkpoints.thread_id
      AND pw.checkpoint_ns = checkpoints.checkpoint_ns
      AND pw.checkpoint_id = checkpoints.checkpoint_id
  ) AS pending_writes
FROM checkpoints`;

const checkpointRow = z.object({
  thread_id: z.string(),
  checkpoint_ns: z.string(),
  checkpoint_id: z.string(),
  parent_checkpoint_id: z.string().nullable(),
  type: z.string().nullable(),
  checkpoint: z.instanceof(Uint8Array),
  metadata: z.instanceof(Uint8Array),
  pending_writes: z.string(),
});

const pendingWriteColumns = z.array(
  z.object({
    task_id: z.string(),
    channel: z.string(),
    type: z.string().nullable(),
    value: z.string().nullable(),
    task_path: z.string().nullable(),
    idx: z.number().nullable(),
  }),
);

const configurable = z
  .object({
    thread_id: z.string().optional(),
    checkpoint_ns: z.string().optional(),
    checkpoint_id: z.string().optional(),
  })
  .loose();

function readConfigurable(config: RunnableConfig) {
  return configurable.parse(config.configurable ?? {});
}

export class NodeSqliteSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Db) {
    super();
    db.exec(SCHEMA);
  }

  /** serde 反序列化的是本类自己写入的 checkpoint / metadata / writes，形状由写入端保证 */
  private async load<T>(type: string | null, data: Uint8Array | string): Promise<T> {
    const value: unknown = await this.serde.loadsTyped(type ?? 'json', data);
    return value as T;
  }

  private async toTuple(
    row: z.infer<typeof checkpointRow>,
    config: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const writes = pendingWriteColumns
      .parse(JSON.parse(row.pending_writes))
      .sort(
        (a, b) =>
          (a.task_path ?? '').localeCompare(b.task_path ?? '') ||
          a.task_id.localeCompare(b.task_id) ||
          (a.idx ?? 0) - (b.idx ?? 0),
      );
    const pendingWrites = await Promise.all(
      writes.map(
        async (w): Promise<[string, string, unknown]> => [
          w.task_id,
          w.channel,
          await this.load<unknown>(w.type, w.value ?? ''),
        ],
      ),
    );
    return {
      config,
      checkpoint: await this.load<Checkpoint>(row.type, row.checkpoint),
      metadata: await this.load<CheckpointMetadata>(row.type, row.metadata),
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: row.checkpoint_ns,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = '', checkpoint_id } = readConfigurable(config);
    if (!thread_id) return undefined;
    const raw = checkpoint_id
      ? this.db
          .prepare(`${SELECT} WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`)
          .get(thread_id, checkpoint_ns, checkpoint_id)
      : this.db
          .prepare(
            `${SELECT} WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1`,
          )
          .get(thread_id, checkpoint_ns);
    if (!raw) return undefined;
    const row = checkpointRow.parse(raw);
    const finalConfig: RunnableConfig = checkpoint_id
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        };
    return this.toTuple(row, finalConfig);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { thread_id, checkpoint_ns } = readConfigurable(config);
    const where: string[] = [];
    const args: string[] = [];
    if (thread_id) {
      where.push('thread_id = ?');
      args.push(thread_id);
    }
    if (checkpoint_ns !== undefined) {
      where.push('checkpoint_ns = ?');
      args.push(checkpoint_ns);
    }
    const before = options?.before
      ? readConfigurable(options.before).checkpoint_id
      : undefined;
    if (before) {
      where.push('checkpoint_id < ?');
      args.push(before);
    }
    let sql = SELECT;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY checkpoint_id DESC';
    if (options?.limit) sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
    for (const raw of this.db.prepare(sql).all(...args)) {
      const row = checkpointRow.parse(raw);
      yield await this.toTuple(row, {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      });
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { thread_id, checkpoint_ns = '', checkpoint_id: parentId } =
      readConfigurable(config);
    if (!thread_id) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".');
    }
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type1 !== type2) {
      throw new Error('Failed to serialize checkpoint and metadata to the same type.');
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread_id,
        checkpoint_ns,
        checkpoint.id,
        parentId ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
      );
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const { thread_id, checkpoint_ns = '', checkpoint_id } = readConfigurable(config);
    if (!thread_id) throw new Error('Missing thread_id field in config.configurable.');
    if (!checkpoint_id) throw new Error('Missing checkpoint_id field in config.configurable.');
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const rows = await Promise.all(
      writes.map(async ([channel, value], idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(value);
        return { channel, idx: WRITES_IDX_MAP[channel] ?? idx, type, serialized };
      }),
    );
    const stmt = this.db.prepare(
      `INSERT ${allSpecial ? 'OR REPLACE' : 'OR IGNORE'} INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
    );
    transaction(this.db, () => {
      for (const r of rows) {
        stmt.run(
          thread_id,
          checkpoint_ns,
          checkpoint_id,
          taskId,
          r.idx,
          r.channel,
          r.type,
          r.serialized,
        );
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM writes WHERE thread_id = ?').run(threadId);
    });
    return Promise.resolve();
  }
}
