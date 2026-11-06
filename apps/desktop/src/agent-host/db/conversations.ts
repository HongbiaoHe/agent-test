/**
 * 会话 / 消息 / token 用量 / 审批记录的读写。行数据用 zod 收窄（node:sqlite 读出的是
 * Record<string, SQLOutputValue>），JSON 列在这里解析成 unknown，由使用方再按需校验。
 */
import { randomUUID } from 'node:crypto';
import {
  groupByModel,
  sumCalls,
  type TokenCall,
  type TokenReport,
} from '@agent-test/agent-core/agent/token-usage';
import { userMessageSummary } from '@agent-test/agent-core/conversations/message-content';
import { z } from 'zod';
import {
  CONVERSATION_STATUSES,
  type ConversationStatus,
  type ConversationSearchHit,
  type ConversationSummary,
  type StoredMessage,
} from '../../shared/rpc';
import { WORKSPACE_PERMISSIONS, type WorkspacePermission } from '../../shared/workspace';
import { hostI18n } from '../i18n';
import { type Db, transaction } from './database';

const conversationRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  goal: z.string(),
  status: z.enum(CONVERSATION_STATUSES),
  model: z.string().nullable(),
  thinking_level: z.string().nullable(),
  workspace_dir: z.string().nullable(),
  permission: z.enum(WORKSPACE_PERMISSIONS),
  created_at: z.number(),
  updated_at: z.number(),
  pinned_at: z.number().nullable(),
});

const usageRow = z.object({
  id: z.string(),
  turn_message_id: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_creation_tokens: z.number(),
  created_at: z.number(),
});

const messageRow = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.string(),
  type: z.string(),
  content: z.string(),
  created_at: z.number(),
});

function toSummary(
  r: z.infer<typeof conversationRow>,
  defaultWorkspace: string,
): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    status: r.status,
    model: r.model,
    thinkingLevel: r.thinking_level,
    workspaceDir: r.workspace_dir ?? defaultWorkspace,
    permission: r.permission,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pinnedAt: r.pinned_at,
  };
}

const SEARCH_LIMIT = 50;
/** 命中片段：命中处之前留这么多字，总长不超过 SNIPPET_LEN */
const SNIPPET_BEFORE = 30;
const SNIPPET_LEN = 120;

/** LIKE 的通配符转义（ESCAPE '\'） */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 截取命中词附近的一段，换行压成空格 */
function snippetOf(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const body = flat.slice(start, start + SNIPPET_LEN);
  return `${start > 0 ? '…' : ''}${body}${start + SNIPPET_LEN < flat.length ? '…' : ''}`;
}

function toMessage(r: z.infer<typeof messageRow>): StoredMessage {
  return {
    id: r.id,
    seq: r.seq,
    role: r.role,
    type: r.type,
    content: parseJson(r.content),
    createdAt: r.created_at,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface TokenUsageInput {
  conversationId: string;
  turnMessageId: string;
  messageId: string | null;
  model: string;
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheCreation: number;
}

export class ConversationRepo {
  constructor(
    private readonly db: Db,
    /** 没存过工作区的旧会话跟随的默认工作区（设置里的 workspaceDir） */
    private readonly defaultWorkspace: () => string,
  ) {}

  list(): ConversationSummary[] {
    const fallback = this.defaultWorkspace();
    return this.db
      .prepare('SELECT * FROM conversation ORDER BY updated_at DESC')
      .all()
      .map((r) => toSummary(conversationRow.parse(r), fallback));
  }

  get(id: string): ConversationSummary | null {
    const r = this.db.prepare('SELECT * FROM conversation WHERE id = ?').get(id);
    return r ? toSummary(conversationRow.parse(r), this.defaultWorkspace()) : null;
  }

  require(id: string): ConversationSummary {
    const c = this.get(id);
    if (!c) throw new Error(hostI18n.t('errors.conversation.notFound', { id }));
    return c;
  }

  create(
    model: string | null,
    workspace: { dir?: string; permission?: WorkspacePermission } = {},
  ): ConversationSummary {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversation (id, title, goal, status, model, thinking_level, workspace_dir, permission, created_at, updated_at)
         VALUES (?, NULL, '', 'idle', ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        model,
        workspace.dir ?? this.defaultWorkspace(),
        workspace.permission ?? 'ask',
        now,
        now,
      );
    return this.require(id);
  }

  /** 改权限档位（下一轮运行生效） */
  setPermission(id: string, permission: WorkspacePermission): ConversationSummary {
    this.require(id);
    this.db
      .prepare('UPDATE conversation SET permission = ?, updated_at = ? WHERE id = ?')
      .run(permission, Date.now(), id);
    return this.require(id);
  }

  /** 改工作区目录：只允许还没有任何消息的会话（附件副本、历史里的路径都依赖它） */
  setWorkspaceDir(id: string, dir: string): ConversationSummary {
    this.require(id);
    if (this.nextSeq(id) > 0) throw new Error(hostI18n.t('errors.conversation.workspaceLocked'));
    this.db
      .prepare('UPDATE conversation SET workspace_dir = ?, updated_at = ? WHERE id = ?')
      .run(dir, Date.now(), id);
    return this.require(id);
  }

  update(
    id: string,
    patch: {
      title?: string;
      model?: string;
      thinkingLevel?: string | null;
      goal?: string;
    },
  ): ConversationSummary {
    const cur = this.require(id);
    this.db
      .prepare(
        `UPDATE conversation SET title = ?, model = ?, thinking_level = ?, goal = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? cur.title,
        patch.model ?? cur.model,
        patch.thinkingLevel === undefined
          ? cur.thinkingLevel
          : patch.thinkingLevel,
        patch.goal ?? cur.goal,
        Date.now(),
        id,
      );
    return this.require(id);
  }

  /** 置顶 / 取消置顶：不动 updated_at（否则会话会跳到「今天」分组） */
  setPinned(id: string, pinned: boolean): ConversationSummary {
    this.require(id);
    this.db.prepare('UPDATE conversation SET pinned_at = ? WHERE id = ?').run(pinned ? Date.now() : null, id);
    return this.require(id);
  }

  /**
   * 按标题 / 首条目标 / 消息正文（type=message 的 text）做不区分大小写的子串匹配，按最近活动倒序。
   * 每个会话只取最近一条命中的消息作片段。
   */
  search(query: string): ConversationSearchHit[] {
    const pattern = likePattern(query);
    const fallback = this.defaultWorkspace();
    const hitRow = z.object({ hit: z.string().nullable() });
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT c.*, (
             SELECT json_extract(m.content, '$.text') FROM message m
             WHERE m.conversation_id = c.id AND m.type = 'message'
               AND json_extract(m.content, '$.text') LIKE :p ESCAPE '\\'
             ORDER BY m.seq DESC LIMIT 1
           ) AS hit
           FROM conversation c
         )
         WHERE COALESCE(title, '') LIKE :p ESCAPE '\\' OR goal LIKE :p ESCAPE '\\' OR hit IS NOT NULL
         ORDER BY updated_at DESC LIMIT ${SEARCH_LIMIT}`,
      )
      .all({ p: pattern })
      .map((r) => {
        const { hit } = hitRow.parse(r);
        return {
          conversation: toSummary(conversationRow.parse(r), fallback),
          snippet: hit ? snippetOf(hit, query) : null,
        };
      });
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversation WHERE id = ?').run(id);
  }

  setStatus(id: string, status: ConversationStatus): void {
    this.db
      .prepare('UPDATE conversation SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  /** CAS：仅当当前状态在 from 之中才改成 to；返回是否改成功（与 backend worker 的 updateMany 门同义） */
  transition(
    id: string,
    from: readonly ConversationStatus[],
    to: ConversationStatus,
  ): boolean {
    const placeholders = from.map(() => '?').join(', ');
    const res = this.db
      .prepare(
        `UPDATE conversation SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(to, Date.now(), id, ...from);
    return Number(res.changes) > 0;
  }

  /** agent-host 启动时把上次没跑完的会话标成失败（崩溃 / 强退后的收尾），返回受影响的会话 id */
  failInterrupted(): string[] {
    const ids = this.db
      .prepare("SELECT id FROM conversation WHERE status = 'running'")
      .all()
      .map((r) => z.object({ id: z.string() }).parse(r).id);
    for (const id of ids) {
      transaction(this.db, () => {
        this.setStatus(id, 'failed');
        this.appendMessage(id, 'assistant', 'error', {
          message: hostI18n.t('errors.conversation.interrupted'),
        });
      });
    }
    return ids;
  }

  // ── messages ──────────────────────────────────────────────────────────────

  messages(conversationId: string): StoredMessage[] {
    return this.db
      .prepare('SELECT * FROM message WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId)
      .map((r) => toMessage(messageRow.parse(r)));
  }

  nextSeq(conversationId: string): number {
    const r = this.db
      .prepare(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM message WHERE conversation_id = ?',
      )
      .get(conversationId);
    return z.object({ next: z.number() }).parse(r).next;
  }

  appendMessage(
    conversationId: string,
    role: string,
    type: string,
    content: unknown,
  ): StoredMessage {
    const id = randomUUID();
    const now = Date.now();
    const seq = this.nextSeq(conversationId);
    this.db
      .prepare(
        `INSERT INTO message (id, conversation_id, seq, role, type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, conversationId, seq, role, type, JSON.stringify(content), now);
    this.db
      .prepare('UPDATE conversation SET updated_at = ? WHERE id = ?')
      .run(now, conversationId);
    return { id, seq, role, type, content, createdAt: now };
  }

  /** 最近一条 plan_update 的内容（计划延续用） */
  lastOfType(conversationId: string, type: string): StoredMessage | null {
    const r = this.db
      .prepare(
        'SELECT * FROM message WHERE conversation_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(conversationId, type);
    return r ? toMessage(messageRow.parse(r)) : null;
  }

  lastUserMessageId(conversationId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT id FROM message WHERE conversation_id = ? AND role = 'user' AND type = 'message' ORDER BY seq DESC LIMIT 1",
      )
      .get(conversationId);
    return r ? z.object({ id: z.string() }).parse(r).id : null;
  }

  // ── token usage ───────────────────────────────────────────────────────────

  usageMessageIds(conversationId: string): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT message_id FROM token_usage WHERE conversation_id = ? AND message_id IS NOT NULL',
      )
      .all(conversationId);
    return new Set(
      rows.map((r) => z.object({ message_id: z.string() }).parse(r).message_id),
    );
  }

  totalTokens(conversationId: string): number {
    const r = this.db
      .prepare(
        'SELECT COALESCE(SUM(total_tokens), 0) AS total FROM token_usage WHERE conversation_id = ?',
      )
      .get(conversationId);
    return z.object({ total: z.number() }).parse(r).total;
  }

  /**
   * token 用量报表：会话总计 + 按模型 + 按轮（含每次调用明细），口径同 backend
   * ConversationsService.tokenReport——一轮 = 触发它的用户消息，起止取本轮首末次调用，按轮倒序。
   */
  tokenReport(conversationId: string): TokenReport {
    this.require(conversationId);
    const rows = this.db
      .prepare('SELECT * FROM token_usage WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId)
      .map((r) => usageRow.parse(r));
    const byTurn = new Map<string, TokenCall[]>();
    for (const r of rows) {
      const call: TokenCall = {
        id: r.id,
        model: r.model,
        input: r.input_tokens,
        output: r.output_tokens,
        total: r.total_tokens,
        cacheRead: r.cache_read_tokens,
        cacheCreation: r.cache_creation_tokens,
        at: new Date(r.created_at).toISOString(),
      };
      const list = byTurn.get(r.turn_message_id);
      if (list) list.push(call);
      else byTurn.set(r.turn_message_id, [call]);
    }
    const goalStmt = this.db.prepare(
      'SELECT content FROM message WHERE id = ? AND conversation_id = ?',
    );
    const goalOf = (turnId: string): string => {
      const r = goalStmt.get(turnId, conversationId);
      if (!r) return '';
      return userMessageSummary(parseJson(z.object({ content: z.string() }).parse(r).content));
    };
    const calls = [...byTurn.values()].flat();
    return {
      totals: sumCalls(calls),
      byModel: groupByModel(calls),
      runs: [...byTurn]
        .map(([turnId, turnCalls]) => ({
          runId: turnId,
          goal: goalOf(turnId),
          startedAt: turnCalls[0].at,
          endedAt: turnCalls[turnCalls.length - 1].at,
          totals: sumCalls(turnCalls),
          byModel: groupByModel(turnCalls),
          calls: turnCalls,
        }))
        .reverse(),
    };
  }

  /** 记一次模型调用；同一 AIMessage 已记过（唯一键冲突）返回 false */
  recordUsage(u: TokenUsageInput): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO token_usage
         (id, conversation_id, turn_message_id, message_id, model, input_tokens, output_tokens,
          total_tokens, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        u.conversationId,
        u.turnMessageId,
        u.messageId,
        u.model,
        u.input,
        u.output,
        u.total,
        u.cacheRead,
        u.cacheCreation,
        Date.now(),
      );
    return Number(res.changes) > 0;
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  recordApproval(conversationId: string, decision: string, payload: unknown): void {
    this.db
      .prepare(
        'INSERT INTO approval (id, conversation_id, decision, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), conversationId, decision, JSON.stringify(payload), Date.now());
  }
}
