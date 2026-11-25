/**
 * 待发消息：agent 还在跑（或停在审批上）的时候用户又发来的消息，还没送达 agent 的那部分。
 * - steer（运行中按 Enter）：主 agent 下一次模型调用前作为用户消息插入（见 agent-core run/steering.ts）；
 * - queue（运行中按 ⌘Enter，或以 / 开头的命令）：这一轮结束后作为新一轮的用户消息。
 * 这一轮正常结束时还没送达的（没赶上插入的 steer + 所有 queue）合并成新的一轮；被停止 / 失败 / 应用重启时
 * 留在这里等用户决定（发送、编辑或删除），不自动开跑。送达即从这里删掉、写进 message 表。
 *
 * 内容与普通用户消息同形（{ text, attachments }，附件在入队时就已复制成副本），送达时原样落库。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PENDING_KINDS, type PendingKind, type PendingMessage } from '../../shared/rpc';
import type { Db } from '../db/database';
import { parseUserContent, type UserContent } from '../run/attachments';

const pendingRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  kind: z.enum(PENDING_KINDS),
  content: z.string(),
  created_at: z.number(),
});

/** 库里的一条待发消息：view 给界面，content 送达时落库 */
export interface PendingEntry {
  view: PendingMessage;
  conversationId: string;
  content: UserContent;
}

function toEntry(r: z.infer<typeof pendingRow>): PendingEntry {
  // content 是本类自己写入的 JSON：解析失败按空消息处理（parseUserContent 的兜底）
  let raw: unknown = null;
  try {
    raw = JSON.parse(r.content);
  } catch {
    raw = null;
  }
  const content = parseUserContent(raw);
  return {
    conversationId: r.conversation_id,
    content,
    view: {
      id: r.id,
      kind: r.kind,
      text: content.text,
      attachments: content.attachments.map((a) => ({ filename: a.filename, path: a.path, size: a.size })),
      createdAt: r.created_at,
    },
  };
}

export class PendingStore {
  constructor(private readonly db: Db) {}

  add(conversationId: string, kind: PendingKind, content: UserContent): PendingEntry {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO pending_message (id, conversation_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, conversationId, kind, JSON.stringify(content), Date.now());
    const entry = this.get(id);
    if (!entry) throw new Error('pending message vanished right after insert');
    return entry;
  }

  /** 按发出顺序（同一毫秒内按插入顺序） */
  list(conversationId: string): PendingEntry[] {
    return this.db
      .prepare('SELECT * FROM pending_message WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId)
      .map((r) => toEntry(pendingRow.parse(r)));
  }

  get(id: string): PendingEntry | null {
    const r = this.db.prepare('SELECT * FROM pending_message WHERE id = ?').get(id);
    return r ? toEntry(pendingRow.parse(r)) : null;
  }

  /** 取走一条（送达 / 用户删除 / 退回输入框编辑）；已经不在了返回 null */
  take(id: string): PendingEntry | null {
    const entry = this.get(id);
    if (!entry) return null;
    this.db.prepare('DELETE FROM pending_message WHERE id = ?').run(id);
    return entry;
  }
}
