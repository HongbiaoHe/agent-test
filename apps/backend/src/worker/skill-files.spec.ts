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

  it('空技能列表返回空表', () => {
    expect(buildSkillFiles([], '2026-06-01T00:00:00.000Z')).toEqual({});
  });
});
