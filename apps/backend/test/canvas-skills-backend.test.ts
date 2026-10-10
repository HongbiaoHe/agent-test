/**
 * 画布只读技能库走真实的 deepagents CompositeBackend / StoreBackend——验证 agent 的
 * read_file / ls 最终打到的那一层，而不是自己的假实现。
 *
 * 用 node:test + tsx 跑而不是 jest：deepagents 依赖一串 ESM-only 包（p-retry、p-queue…），
 * jest 的 CJS 运行时加载不了。运行：pnpm --filter backend test:deepagents
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSkillsLibrary } from '../src/canvas-skills/skills-backend';

const creator = {
  name: 'skills-creator',
  files: {
    'SKILL.md':
      '---\nname: skills-creator\ndescription: d\n---\n\n先读 `./references/caps.md`',
    'references/caps.md': '能力清单',
  },
};

const text = (v: unknown) => JSON.stringify(v);

void describe('createSkillsLibrary', () => {
  void it('/skills/<名>/SKILL.md 可读，相对引用已改写为绝对路径', async () => {
    const { backend } = await createSkillsLibrary([creator]);
    const r = await backend.read('/skills/skills-creator/SKILL.md');
    assert.equal(r.error, undefined);
    assert.match(
      text(r.content),
      /\/skills\/skills-creator\/references\/caps\.md/,
    );
    const ref = await backend.read('/skills/skills-creator/references/caps.md');
    assert.match(text(ref.content), /能力清单/);
  });

  void it('ls /skills/ 列出技能目录（deepagents 规范的目录结构）', async () => {
    const { backend } = await createSkillsLibrary([creator]);
    const ls = await backend.ls('/skills/');
    assert.ok(
      ls.files?.some((f) => f.path === '/skills/skills-creator/'),
      text(ls),
    );
  });

  void it('只读：write / edit 返回错误且不落进去', async () => {
    const { backend } = await createSkillsLibrary([creator]);
    const w = await backend.write('/skills/hack/SKILL.md', 'x');
    assert.match(w.error ?? '', /只读/);
    const e = await backend.edit(
      '/skills/skills-creator/SKILL.md',
      '先读',
      '改掉',
    );
    assert.match(e.error ?? '', /只读/);
    const still = await backend.read('/skills/skills-creator/SKILL.md');
    assert.match(text(still.content), /先读/);
    assert.ok((await backend.read('/skills/hack/SKILL.md')).error);
  });

  void it('运行中 put 的新技能当轮可读', async () => {
    const lib = await createSkillsLibrary([creator]);
    await lib.put({
      name: 'teaser',
      files: { 'SKILL.md': '---\nname: teaser\ndescription: d\n---\n\n步骤' },
    });
    const r = await lib.backend.read('/skills/teaser/SKILL.md');
    assert.match(text(r.content), /步骤/);
  });
});
