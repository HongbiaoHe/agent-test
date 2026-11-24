import { describe, expect, it } from 'vitest';
import { buildGroups, flatItems, GROUP_LIMIT, nextType, RECENT_LIMIT, type SearchItem } from './search-items';

const conv = (id: string, recency: number): SearchItem => ({
  key: `c:${id}`,
  type: 'conversation',
  title: `会话 ${id}`,
  recency,
  target: { kind: 'chat', id },
});
const items: SearchItem[] = [
  conv('a', 1),
  conv('b', 5),
  { key: 'v:1', type: 'canvas', title: '耳机广告画布', recency: 3, target: { kind: 'canvas', canvasId: '1' } },
  { key: 's:tvc', type: 'skill', title: 'tvc-director', subtitle: '产品广告分镜与视频脚本', target: { kind: 'settings', section: 'skills' } },
  { key: 'm:seo', type: 'mode', title: 'SEO 助手', target: { kind: 'settings', section: 'modes' } },
  { key: 'set:models', type: 'setting', title: '模型', subtitle: 'API 连接与默认模型', target: { kind: 'settings', section: 'models' } },
  { key: 'act:new', type: 'action', title: '新建对话', target: { kind: 'new-chat' } },
];

describe('全局搜索分组', () => {
  it('空关键词 + 全部：最近使用（会话与画布按最近活动排）+ 操作', () => {
    const groups = buildGroups({ query: '', type: 'all', items, conversationHits: [] });
    expect(groups.map((g) => g.id)).toEqual(['recent', 'actions']);
    expect(groups[0].items.map((i) => i.key)).toEqual(['c:b', 'v:1', 'c:a']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['act:new']);
  });

  it('最近使用最多 RECENT_LIMIT 条', () => {
    const many = Array.from({ length: 20 }, (_, i) => conv(String(i), i));
    expect(buildGroups({ query: '', type: 'all', items: many, conversationHits: [] })[0].items).toHaveLength(RECENT_LIMIT);
  });

  it('空关键词 + 指定类型：列出该类型全部', () => {
    expect(buildGroups({ query: '', type: 'skill', items, conversationHits: [] })).toEqual([{ id: 'skill', items: [items[3]] }]);
  });

  it('有关键词：会话用服务端结果，其余本地按标题 / 说明匹配（不区分大小写），按类型分组', () => {
    const hit = { ...conv('x', 0), snippet: '……做一条广告……' };
    const groups = buildGroups({ query: '广告', type: 'all', items, conversationHits: [hit] });
    expect(groups.map((g) => [g.id, g.items.map((i) => i.key)])).toEqual([
      ['conversation', ['c:x']],
      ['canvas', ['v:1']],
      ['skill', ['s:tvc']],
    ]);
    expect(buildGroups({ query: 'SEO', type: 'all', items, conversationHits: [] })[0].items[0].key).toBe('m:seo');
    expect(buildGroups({ query: 'seo', type: 'mode', items, conversationHits: [] })[0].items[0].key).toBe('m:seo');
  });

  it('全部视图每组最多 GROUP_LIMIT 条；指定类型不截断', () => {
    const skills = Array.from({ length: 9 }, (_, i): SearchItem => ({
      key: `s:${i}`,
      type: 'skill',
      title: `skill ${i}`,
      target: { kind: 'settings', section: 'skills' },
    }));
    expect(buildGroups({ query: 'skill', type: 'all', items: skills, conversationHits: [] })[0].items).toHaveLength(GROUP_LIMIT);
    expect(buildGroups({ query: 'skill', type: 'skill', items: skills, conversationHits: [] })[0].items).toHaveLength(9);
  });

  it('标题命中排在只有说明命中的前面；摊平顺序；类型循环切换', () => {
    const two: SearchItem[] = [
      { key: 'a', type: 'setting', title: '外观', subtitle: '模型无关', target: { kind: 'settings', section: 'appearance' } },
      { key: 'b', type: 'setting', title: '模型', target: { kind: 'settings', section: 'models' } },
    ];
    const groups = buildGroups({ query: '模型', type: 'all', items: two, conversationHits: [] });
    expect(flatItems(groups).map((i) => i.key)).toEqual(['b', 'a']);
    expect(nextType('all', -1)).toBe('setting');
    expect(nextType('setting', 1)).toBe('all');
  });
});
