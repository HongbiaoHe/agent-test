import { InMemoryStore } from '@langchain/langgraph';
import { seedSkillsStore } from './skill-store.seed';
import type { SkillDef } from './skills.service';

const def = (name: string, files: Record<string, string>): SkillDef =>
  ({ name, description: 'd', kind: 'builtin', source: 'builtin', enabled: true, files });

describe('seedSkillsStore', () => {
  it('把技能文件播到 [userId,"skills"]，key 为挂载点相对路径 /<name>/<rel>，SKILL.md 经 absolutize', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [
      def('tvc', { 'SKILL.md': '看 `./references/a.md`', 'references/a.md': 'A' }),
    ]);
    const items = await store.search(['u1', 'skills']);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual(['/tvc/SKILL.md', '/tvc/references/a.md']);
    const md = items.find((i) => i.key.endsWith('SKILL.md'))!.value as { content: string[] };
    expect(md.content.join('\n')).toContain('/skills/tvc/references/a.md');
  });

  it('diff 同步：移除不再生效技能的旧键、更新变更内容', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [def('a', { 'SKILL.md': 'v1' })]);
    await seedSkillsStore(store, 'u1', [def('b', { 'SKILL.md': 'x' })]);
    const keys = (await store.search(['u1', 'skills'])).map((i) => i.key);
    expect(keys).toEqual(['/b/SKILL.md']);
  });

  it('namespace 按用户隔离', async () => {
    const store = new InMemoryStore();
    await seedSkillsStore(store, 'u1', [def('a', { 'SKILL.md': 'x' })]);
    expect(await store.search(['u2', 'skills'])).toEqual([]);
  });
});
