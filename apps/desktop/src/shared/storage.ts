/**
 * 存储占用（设置 → 存储）：当前账号下每个会话在本机占了多少、分别是什么，以及不属于任何会话的共享缓存。
 * 扫描与清理都在 agent-host（agent-host/storage/），这里是 renderer 与它之间的数据形状。
 */
import type { ConversationStatus } from './rpc';

/**
 * 每个会话的占用分类。
 * - 数据（删会话才会清）：messages 消息记录、attachments 附件副本、outputs 本会话新建的产出文件；
 * - 缓存（可单独清，不影响对话内容）：checkpoints 审批续跑状态、skills 技能副本、snapshots 剪辑撤销快照。
 */
export const STORAGE_CATEGORIES = ['messages', 'attachments', 'outputs', 'checkpoints', 'skills', 'snapshots'] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export const CACHE_CATEGORIES = ['checkpoints', 'skills', 'snapshots'] as const satisfies readonly StorageCategory[];
export type CacheCategory = (typeof CACHE_CATEGORIES)[number];

/** 不属于单个会话的缓存：thumbnails 视频预览帧（按素材路径缓存）、orphans 已删会话残留的目录 */
export const SHARED_CACHE_CATEGORIES = ['thumbnails', 'orphans'] as const;
export type SharedCacheCategory = (typeof SHARED_CACHE_CATEGORIES)[number];

export function isCacheCategory(c: StorageCategory): c is CacheCategory {
  return CACHE_CATEGORIES.some((x) => x === c);
}

export interface StorageUsage {
  bytes: number;
  /** 条目数：消息条数 / 文件数 / checkpoint 份数 */
  count: number;
}

export interface ConversationStorage {
  id: string;
  title: string | null;
  goal: string;
  status: ConversationStatus;
  updatedAt: number;
  /** 正在运行或停在审批上：缓存正被使用，清缓存时跳过它 */
  busy: boolean;
  usage: Record<StorageCategory, StorageUsage>;
  totalBytes: number;
  /** 其中可单独清掉的缓存 */
  cacheBytes: number;
}

export interface StorageReport {
  conversations: ConversationStorage[];
  shared: Record<SharedCacheCategory, StorageUsage>;
  /** 数据库文件的大小（主文件 + WAL；消息、checkpoint 都在里面，删数据后空出来的页攒够了才整理缩小） */
  databaseBytes: number;
  scannedAt: number;
}

export interface ClearCacheResult {
  freedBytes: number;
  /** 因为正在运行 / 等审批而跳过的会话 */
  skipped: string[];
}

export interface DeleteConversationsResult {
  deleted: string[];
  /** 移进废纸篓的产出文件数 */
  trashedFiles: number;
  /** 没能移进废纸篓的文件（仍留在原处） */
  failedFiles: string[];
}
