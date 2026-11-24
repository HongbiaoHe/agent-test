/**
 * 全局搜索的条目（纯函数，单测见 search-items.test.ts）：把会话、画布、技能、模式、连接器、模型连接、设置页、
 * 常用操作统一成一种条目，按类型筛、按关键词匹配，再分组给搜索弹窗显示。
 *
 * - 会话按标题与消息正文搜（agent-host conversations.search，结果带命中片段），其余在本地按名称 / 说明匹配；
 * - 空关键词：「全部」显示最近使用（会话与画布按最近活动排）+ 常用操作；选了某个类型就列出该类型全部条目；
 * - 有关键词：「全部」按类型分组、每组最多 GROUP_LIMIT 条；选了某个类型就只列该类型。
 */

export const SEARCH_TYPES = ['all', 'conversation', 'canvas', 'skill', 'mode', 'connector', 'model', 'setting'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export type ItemType = Exclude<SearchType, 'all'> | 'action';

import type { SettingsSection } from '../settings/settings-dialog';

export type SearchTarget =
  | { kind: 'chat'; id: string }
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'settings'; section: SettingsSection }
  | { kind: 'new-chat' }
  | { kind: 'canvas-list' };

export interface SearchItem {
  /** 列表里的唯一键 */
  key: string;
  type: ItemType;
  title: string;
  /** 标题后面的灰字（来源、说明） */
  subtitle?: string;
  /** 会话正文的命中片段 */
  snippet?: string;
  /** 最近活动（毫秒）：最近使用排序用 */
  recency?: number;
  target: SearchTarget;
}

export interface SearchGroup {
  /** 分组：最近使用 / 操作 / 各类型 */
  id: 'recent' | 'actions' | ItemType;
  items: SearchItem[];
}

export const RECENT_LIMIT = 8;
export const GROUP_LIMIT = 5;

/** 不区分大小写的包含匹配：标题、灰字、片段任一命中即可；标题命中排在前面 */
function score(item: SearchItem, q: string): number {
  if (item.title.toLowerCase().includes(q)) return 2;
  if (item.subtitle?.toLowerCase().includes(q) || item.snippet?.toLowerCase().includes(q)) return 1;
  return 0;
}

/**
 * items：本地数据源的全部条目（不含会话搜索结果）；conversationHits：关键词非空时 conversations.search 的结果
 * （已按服务端相关度排好）；关键词为空时会话也在 items 里。
 */
export function buildGroups(opts: {
  query: string;
  type: SearchType;
  items: readonly SearchItem[];
  conversationHits: readonly SearchItem[];
}): SearchGroup[] {
  const q = opts.query.trim().toLowerCase();
  const ofType = (t: ItemType) => opts.items.filter((i) => i.type === t);

  if (!q) {
    if (opts.type !== 'all') return [{ id: opts.type, items: ofType(opts.type) }].filter((g) => g.items.length > 0);
    const recent = opts.items
      .filter((i) => i.recency !== undefined)
      .sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))
      .slice(0, RECENT_LIMIT);
    return [
      { id: 'recent' as const, items: recent },
      { id: 'actions' as const, items: ofType('action') },
    ].filter((g) => g.items.length > 0);
  }

  const matched = (t: ItemType): SearchItem[] => {
    if (t === 'conversation') return [...opts.conversationHits];
    return ofType(t)
      .map((item) => ({ item, s: score(item, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item);
  };
  if (opts.type !== 'all') return [{ id: opts.type, items: matched(opts.type) }].filter((g) => g.items.length > 0);
  const order: ItemType[] = ['conversation', 'canvas', 'skill', 'mode', 'connector', 'model', 'setting', 'action'];
  return order
    .map((t) => ({ id: t, items: matched(t).slice(0, GROUP_LIMIT) }))
    .filter((g) => g.items.length > 0);
}

/** 分组摊平成键盘上下移动的顺序 */
export const flatItems = (groups: readonly SearchGroup[]): SearchItem[] => groups.flatMap((g) => g.items);

/** ←→ 切换类型：循环 */
export function nextType(type: SearchType, step: 1 | -1): SearchType {
  const i = SEARCH_TYPES.indexOf(type);
  return SEARCH_TYPES[(i + step + SEARCH_TYPES.length) % SEARCH_TYPES.length];
}
