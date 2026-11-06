/**
 * 侧栏会话分组（纯函数，单测见 conversation-groups.test.ts）：
 * 「已置顶」在最上（按置顶时刻倒序），其余按最近活动（updatedAt）落进 今天 / 昨天 / 最近 7 天 / 更早，
 * 组内保持传入顺序（agent-host 已按 updatedAt 倒序给出）。空组不出现。
 */
import type { ConversationSummary } from '../../../../shared/rpc';

export type GroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export interface ConversationGroup {
  /** 显示名见字典 shell.groups.<key> */
  key: GroupKey;
  items: ConversationSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地时区当天 0 点 */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupConversations(list: ConversationSummary[], now: number): ConversationGroup[] {
  const today = startOfDay(now);
  const buckets: Record<GroupKey, ConversationSummary[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const c of list) {
    if (c.pinnedAt !== null) buckets.pinned.push(c);
    else if (c.updatedAt >= today) buckets.today.push(c);
    else if (c.updatedAt >= today - DAY_MS) buckets.yesterday.push(c);
    else if (c.updatedAt >= today - 6 * DAY_MS) buckets.week.push(c);
    else buckets.older.push(c);
  }
  buckets.pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  return (Object.keys(buckets) as GroupKey[])
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, items: buckets[key] }));
}
