import type { CommandDef } from '../commands/command-registry.service';
import { buildSkillFiles } from './skill-files';

describe('buildSkillFiles', () => {
  const def = (files: Record<string, string>): CommandDef => ({
    name: 'tvc-director',
    description: '',
    domain: 'tvc',
    raw: files['SKILL.md'] ?? '',
    files,
  });

  it('注入整棵技能目录（SKILL.md + references/**），键为 /skills/<name>/<rel>', () => {
    const out = buildSkillFiles(
      [
        def({
          'SKILL.md': '# skill\n见 references/treatment.md',
          'references/treatment.md': 'a\nb',
        }),
      ],
      '2026-06-01T00:00:00.000Z',
    );

    expect(Object.keys(out).sort()).toEqual([
      '/skills/tvc-director/SKILL.md',
      '/skills/tvc-director/references/treatment.md',
    ]);
    // 子文件内容按行切分存入 StateBackend，agent read_file 时才能读到
    expect(out['/skills/tvc-director/references/treatment.md'].content).toEqual([
      'a',
      'b',
    ]);
    expect(out['/skills/tvc-director/SKILL.md'].created_at).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('SKILL.md 里反引号包裹的相对 reference 路径被改写成绝对路径', () => {
    const out = buildSkillFiles(
      [
        def({
          'SKILL.md':
            '---\nname: tvc-director\ndescription: see references later\n---\n见 `references/treatment.md` 和 `references/storyboard.md`',
          'references/treatment.md': 'a\nb',
        }),
      ],
      '2026-06-01T00:00:00.000Z',
    );

    const skillMd = out['/skills/tvc-director/SKILL.md'].content.join('\n');
    // 反引号里的相对路径被改写为绝对路径，命中 StateBackend 真实 key
    expect(skillMd).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(skillMd).toContain('`/skills/tvc-director/references/storyboard.md`');
    // 不再保留裸的相对反引号路径
    expect(skillMd).not.toContain('`references/');
    // frontmatter 的 description 不含 `references/` token，保持原样不被破坏
    expect(skillMd).toContain('description: see references later');
  });

  it('SKILL.md 里带 ./ 前缀的相对 reference 路径被改写成绝对路径（tvc-director 写法）', () => {
    const out = buildSkillFiles(
      [
        def({
          'SKILL.md':
            '见 `./references/treatment.md` Part 1，定调读 `./references/shot-language.md`',
          'references/treatment.md': 'a',
        }),
      ],
      '2026-06-01T00:00:00.000Z',
    );
    const skillMd = out['/skills/tvc-director/SKILL.md'].content.join('\n');
    expect(skillMd).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(skillMd).toContain(
      '`/skills/tvc-director/references/shot-language.md`',
    );
    // 不再保留裸的相对路径（./ 与无 ./ 都不应残留）
    expect(skillMd).not.toContain('`./references/');
  });

  it('markdown 链接 ](./sub-skill.md) 被改写成绝对路径（marketing-strategist 路由表写法）', () => {
    const out = buildSkillFiles(
      [
        {
          name: 'marketing-strategist',
          description: '',
          domain: 'marketing',
          raw: '',
          files: {
            'SKILL.md':
              '| [big-idea](./big-idea-concept-pitching.md) | ... |\n| [brand](./brand-positioning.md) | ... |',
            'big-idea-concept-pitching.md': 'x',
            'brand-positioning.md': 'y',
          },
        },
      ],
      '2026-06-01T00:00:00.000Z',
    );
    const skillMd = out['/skills/marketing-strategist/SKILL.md'].content.join(
      '\n',
    );
    expect(skillMd).toContain(
      '](/skills/marketing-strategist/big-idea-concept-pitching.md)',
    );
    expect(skillMd).toContain(
      '](/skills/marketing-strategist/brand-positioning.md)',
    );
    expect(skillMd).not.toContain('](./');
  });

  it('http(s) 链接与已是绝对路径的引用不被误伤', () => {
    const out = buildSkillFiles(
      [
        def({
          'SKILL.md':
            '参考 [docs](https://example.com/a.md) 与 `/skills/tvc-director/references/treatment.md`',
        }),
      ],
      '2026-06-01T00:00:00.000Z',
    );
    const skillMd = out['/skills/tvc-director/SKILL.md'].content.join('\n');
    expect(skillMd).toContain('](https://example.com/a.md)');
    // 已是绝对路径的不被二次改写
    expect(skillMd).toContain('`/skills/tvc-director/references/treatment.md`');
    expect(skillMd).not.toContain('/skills/tvc-director//skills/');
  });

  it('子文件内容不被改写', () => {
    const out = buildSkillFiles(
      [
        def({
          'SKILL.md': '# skill',
          'references/treatment.md': '见 `references/other.md`',
        }),
      ],
      '2026-06-01T00:00:00.000Z',
    );
    expect(out['/skills/tvc-director/references/treatment.md'].content).toEqual([
      '见 `references/other.md`',
    ]);
  });

  it('空技能列表返回空表', () => {
    expect(buildSkillFiles([], '2026-06-01T00:00:00.000Z')).toEqual({});
  });
});
