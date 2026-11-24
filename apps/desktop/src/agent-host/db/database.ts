/**
 * 本机 SQLite（Node 内置 node:sqlite，无原生模块）：打开、迁移、事务。
 *
 * 只有 agent-host 进程写这个库。表结构参照 apps/backend/prisma/schema.prisma 的同名模型，
 * 去掉 tenantId / userId（桌面端单用户），主键 UUID。
 * JSON 列以 TEXT 存，读出时由 repositories 用 zod 收窄。
 */
import { DatabaseSync } from 'node:sqlite';

/** 按序追加，不改已发布的条目；PRAGMA user_version 记录已执行到第几条。 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE conversation (
    id TEXT PRIMARY KEY,
    title TEXT,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    model TEXT,
    thinking_level TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (conversation_id, seq)
  );
  CREATE TABLE token_usage (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    turn_message_id TEXT NOT NULL,
    message_id TEXT UNIQUE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE approval (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE skill (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL,
    installed_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'disconnected',
    last_error TEXT,
    instructions TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    permissions TEXT NOT NULL DEFAULT '{}',
    oauth_client TEXT,
    oauth_tokens TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX message_conversation_seq ON message (conversation_id, seq);
  `,
  // v2：正在执行的命令进程组（崩溃后清理孤儿进程用，见 workspace/process-tracker.ts）
  `
  CREATE TABLE running_process (
    pgid INTEGER PRIMARY KEY,
    command TEXT NOT NULL,
    started_at INTEGER NOT NULL
  );
  `,
  // v3：每个会话自选工作区与权限档位（NULL 工作区 = 跟随默认工作区，兼容 v2 之前的会话）
  `
  ALTER TABLE conversation ADD COLUMN workspace_dir TEXT;
  ALTER TABLE conversation ADD COLUMN permission TEXT NOT NULL DEFAULT 'ask';
  `,
  // v4：MCP 对齐 Web——推荐连接器来源、认证方式、server 自报信息、工具刷新时间；
  // 进行中的授权落库（agent-host 重启不丢）；会话上的 MCP App 上下文（ui/update-model-context）
  `
  ALTER TABLE mcp_server ADD COLUMN preset_key TEXT;
  ALTER TABLE mcp_server ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE mcp_server ADD COLUMN server_info TEXT;
  ALTER TABLE mcp_server ADD COLUMN tools_refreshed_at INTEGER;
  CREATE TABLE mcp_oauth_pending (
    state TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE conversation ADD COLUMN mcp_app_context TEXT;
  `,
  // v5：会话后台任务（watch_until / run_in_background / schedule_wakeup），对应 backend 的 BackgroundTask。
  // next_tick_at：下一次推进的时刻，agent-host 重启后据此恢复计时
  `
  CREATE TABLE background_task (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    spec TEXT NOT NULL,
    result TEXT,
    polls INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1,
    delivered INTEGER NOT NULL DEFAULT 0,
    deadline_at INTEGER NOT NULL,
    next_tick_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX background_task_conversation ON background_task (conversation_id, status);
  `,
  // v6：会话置顶（侧栏「已置顶」分组）
  `
  ALTER TABLE conversation ADD COLUMN pinned_at INTEGER;
  `,
  // v7：agent 模式（对应 backend 的 AgentMode；JSON 列存 TEXT）+ 会话所选模式（NULL = 通用模式）。
  // 删模式时由 ModeStore 把引用它的会话 mode_id 置空，不用外键级联
  `
  CREATE TABLE agent_mode (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    tool_names TEXT NOT NULL DEFAULT '[]',
    mcp_server_ids TEXT NOT NULL DEFAULT '[]',
    skill_names TEXT NOT NULL DEFAULT '[]',
    default_model TEXT,
    default_thinking_level TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE conversation ADD COLUMN mode_id TEXT;
  `,
  // v8：通用模式（mode_id 为 NULL 的会话）的用户覆盖：单行表，id 恒为 1；没有行 = 全用默认。
  // system_prompt 为 NULL = 用 core 的 GENERAL_MODE_PROMPT
  `
  CREATE TABLE general_mode (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt TEXT,
    default_model TEXT,
    default_thinking_level TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  // v9：平台片段（{{platform.xxx}}）的用户改写：一行一个片段，id 为 core 的 PROMPT_FRAGMENT_IDS 之一；
  // 没有行 = 用 core 默认正文（恢复默认即删行）
  `
  CREATE TABLE prompt_fragment (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v10：用户自建片段（{{custom.xxx}}）：id 创建后不可改，正文 / 显示名可改；仍被模式或通用提示词引用时不能删
  `
  CREATE TABLE custom_prompt_fragment (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v11：模式引用模式作子 agent（对应 backend AgentMode.description / subagentModeIds）
  `
  ALTER TABLE agent_mode ADD COLUMN description TEXT;
  ALTER TABLE agent_mode ADD COLUMN subagent_mode_ids TEXT NOT NULL DEFAULT '[]';
  `,
  // v12：用户自己配置的 API 连接与模型（按账号隔离；Key 不在这里，由 main 加密保存）+ 账号级设置（默认模型等）
  `
  CREATE TABLE llm_connection (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    preset_id TEXT,
    last_listed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE llm_model (
    connection_id TEXT NOT NULL REFERENCES llm_connection(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    display_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    list_state TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    capabilities_edited INTEGER NOT NULL DEFAULT 0,
    test TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (connection_id, model_id)
  );
  CREATE TABLE profile_setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v13：对话绑定的当前画布（Web 账号下的画布 id；画布数据在 Web 后端，本机只记绑定关系）+ 绑定时刻
  // （从画布列表打开时，右侧显示最近绑定它的对话：按绑定时刻而不是最后一条消息的时刻）
  `
  ALTER TABLE conversation ADD COLUMN canvas_id TEXT;
  ALTER TABLE conversation ADD COLUMN canvas_bound_at INTEGER;
  CREATE INDEX conversation_canvas_idx ON conversation(canvas_id, canvas_bound_at);
  `,
  // v14：会话写过的工作区文件（见 storage/conversation-files.ts）。created = 1：写之前文件不存在，是本会话新建的；
  // 删会话时只把「本会话新建、且没有别的会话写过」的文件移进废纸篓。path 是本机绝对路径
  `
  CREATE TABLE conversation_file (
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    created INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, path)
  );
  CREATE INDEX conversation_file_path ON conversation_file (path);
  `,
  // v15：记录里区分目录——会话写文件时顺带新建的各级父目录（is_dir = 1），删会话时文件移走后空了就收掉；
  // 用户项目里原有的目录没有记录，不会被动
  `
  ALTER TABLE conversation_file ADD COLUMN is_dir INTEGER NOT NULL DEFAULT 0;
  `,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);
  for (let i = current; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      // PRAGMA 不支持参数绑定；i 是本地循环下标，不来自外部输入
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

/** 空闲页攒到这么多才整理：VACUUM 要把整个库重写一遍，小碎片不值得（删掉的页本来就会被之后的写入复用） */
const RECLAIM_MIN_FREE_BYTES = 64 * 1024 * 1024;

/**
 * 把删数据空出来的页还给文件系统（SQLite 删行只把页挂进空闲链表，文件不会自己变小）。
 * 空闲量不到 minFreeBytes 不动，返回 0；否则 VACUUM 并截断 WAL，返回整理前的空闲字节数。
 * 不能在事务里调用。
 */
export function reclaimFreeSpace(db: Db, minFreeBytes = RECLAIM_MIN_FREE_BYTES): number {
  const freePages = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
  const free = freePages * pageSize;
  if (free === 0 || free < minFreeBytes) return 0;
  db.exec('VACUUM');
  // WAL 模式下 VACUUM 的结果先写进 WAL：截断一次，主文件才真正缩小、WAL 也不留着
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return free;
}

/** node:sqlite 没有 better-sqlite3 的 transaction() 包装，手写 BEGIN / COMMIT。 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
