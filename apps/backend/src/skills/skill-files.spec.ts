import { absolutizeRefPaths, toFileData } from './skill-files';

// absolutizeRefPaths 测试用例从 src/worker/skill-files.spec.ts 迁入，
// 对应函数已原样迁入 src/skills/skill-files.ts（VERBATIM）。
describe('absolutizeRefPaths', () => {
  it('SKILL.md 里反引号包裹的相对 reference 路径被改写成绝对路径', () => {
    const input =
      '---\nname: tvc-director\ndescription: see references later\n---\n见 `references/treatment.md` 和 `references/storyboard.md`';
    const out = absolutizeRefPaths('tvc-director', input);
    expect(out).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(out).toContain('`/skills/tvc-director/references/storyboard.md`');
    expect(out).not.toContain('`references/');
    // frontmatter description 不含 `references/` token，不受影响
    expect(out).toContain('description: see references later');
  });

  it('SKILL.md 里带 ./ 前缀的相对 reference 路径被改写成绝对路径（tvc-director 写法）', () => {
    const input =
      '见 `./references/treatment.md` Part 1，定调读 `./references/shot-language.md`';
    const out = absolutizeRefPaths('tvc-director', input);
    expect(out).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(out).toContain('`/skills/tvc-director/references/shot-language.md`');
    expect(out).not.toContain('`./references/');
  });

  it('markdown 链接 ](./sub-skill.md) 被改写成绝对路径（marketing-strategist 路由表写法）', () => {
    const input =
      '| [big-idea](./big-idea-concept-pitching.md) | ... |\n| [brand](./brand-positioning.md) | ... |';
    const out = absolutizeRefPaths('marketing-strategist', input);
    expect(out).toContain('](/skills/marketing-strategist/big-idea-concept-pitching.md)');
    expect(out).toContain('](/skills/marketing-strategist/brand-positioning.md)');
    expect(out).not.toContain('](./');
  });

  it('http(s) 链接与已是绝对路径的引用不被误伤', () => {
    const input =
      '参考 [docs](https://example.com/a.md) 与 `/skills/tvc-director/references/treatment.md`';
    const out = absolutizeRefPaths('tvc-director', input);
    expect(out).toContain('](https://example.com/a.md)');
    expect(out).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(out).not.toContain('/skills/tvc-director//skills/');
  });
});

describe('toFileData', () => {
  it('把文本内容按行切分，并设置 created_at / modified_at', () => {
    const now = '2026-06-01T00:00:00.000Z';
    const fd = toFileData('a\nb\nc', now);
    expect(fd).toEqual({
      content: ['a', 'b', 'c'],
      created_at: now,
      modified_at: now,
    });
  });

  it('空内容返回单元素数组（split 行为一致）', () => {
    const fd = toFileData('', '2026-06-01T00:00:00.000Z');
    expect(fd.content).toEqual(['']);
  });
});
