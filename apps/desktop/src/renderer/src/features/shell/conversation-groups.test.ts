import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../../../../shared/rpc';
import { groupConversations } from './conversation-groups';

const NOW = new Date(2026, 10, 5, 15, 0).getTime(); // 本地时间 11-05 15:00
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

function conv(id: string, updatedAt: number, pinnedAt: number | null = null): ConversationSummary {
  return {
    id,
    title: id,
    goal: '',
    status: 'idle',
    model: null,
    thinkingLevel: null,
    workspaceDir: '/w',
    permission: 'ask',
    createdAt: updatedAt,
    updatedAt,
    pinnedAt,
  };
}

describe('groupConversations', () => {
  it('置顶在最上（按置顶时刻倒序），其余按最近活动分 今天 / 昨天 / 最近 7 天 / 更早', () => {
    const list = [
      conv('today', at(10, 5, 0)), // 今天 0 点整也算今天
      conv('pinned-old', at(9, 1), at(10, 1)),
      conv('yesterday', at(10, 4, 23)),
      conv('pinned-new', at(10, 5, 9), at(10, 3)),
      conv('week', at(9, 30)), // 6 天前
      conv('older', at(9, 29, 23)),
    ];
    expect(groupConversations(list, NOW).map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
      ['pinned', ['pinned-new', 'pinned-old']],
      ['today', ['today']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['older', ['older']],
    ]);
  });

  it('空组不出现', () => {
    expect(groupConversations([conv('a', at(10, 5))], NOW).map((g) => g.key)).toEqual(['today']);
    expect(groupConversations([], NOW)).toEqual([]);
  });
});
