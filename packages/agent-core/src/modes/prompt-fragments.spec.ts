import {
  expandPlaceholders,
  findUnknownPlaceholders,
  PROMPT_FRAGMENT_IDS,
} from './prompt-fragments';

describe('prompt fragments', () => {
  it('片段 id 固定为四个平台规则', () => {
    expect([...PROMPT_FRAGMENT_IDS]).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
    ]);
  });

  it('展开占位符：slash_command 用 skillsDir 填路径，空白容忍，前后文保留', () => {
    const out = expandPlaceholders('A\n{{ platform.slash_command }}\nB', {
      skillsDir: '/workspace/skills',
    });
    expect(out).toContain('/workspace/skills/<技能名>/SKILL.md');
    expect(out.startsWith('A\n## 斜杠命令')).toBe(true);
    expect(out.endsWith('\nB')).toBe(true);
  });

  it('同一占位符出现两次就展开两次', () => {
    const out = expandPlaceholders(
      '{{platform.language}}|{{platform.language}}',
      { skillsDir: '/skills' },
    );
    expect(out.match(/## 回复语言/g)).toHaveLength(2);
  });

  it('未知占位符：findUnknownPlaceholders 列出（去重），expand 抛错', () => {
    expect(
      findUnknownPlaceholders(
        '{{platform.nope}} {{platform.language}} {{platform.nope}} {{x.y}}',
      ),
    ).toEqual(['platform.nope', 'x.y']);
    expect(() =>
      expandPlaceholders('{{platform.nope}}', { skillsDir: '/skills' }),
    ).toThrow(/platform\.nope/);
  });

  it('没有占位符的正文原样返回', () => {
    expect(expandPlaceholders('plain', { skillsDir: '/s' })).toBe('plain');
  });
});
