import {
  expandPlaceholders,
  findInvalidFragmentVariables,
  findUnknownPlaceholders,
  isPromptFragmentId,
  PROMPT_FRAGMENT_DEFAULTS,
  PROMPT_FRAGMENT_IDS,
  renderFragment,
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

describe('片段覆盖与 {{skills_dir}}', () => {
  it('默认正文里技能库路径写成 {{skills_dir}}，渲染时替换', () => {
    expect(PROMPT_FRAGMENT_DEFAULTS['platform.slash_command']).toContain(
      '{{skills_dir}}/<技能名>/SKILL.md',
    );
    expect(
      renderFragment('platform.slash_command', { skillsDir: '/w/skills' }),
    ).toContain('/w/skills/<技能名>/SKILL.md');
    expect(
      renderFragment('platform.slash_command', { skillsDir: '/w/skills' }),
    ).not.toContain('{{');
  });

  it('覆盖只替换对应片段，{{skills_dir}} 在覆盖文本里同样展开；其它片段仍用默认', () => {
    const out = expandPlaceholders(
      '{{platform.language}}\n{{platform.slash_command}}',
      {
        skillsDir: '/s',
        overrides: {
          'platform.slash_command': '命令技能在 {{ skills_dir }} 下',
        },
      },
    );
    expect(out).toBe(
      `${PROMPT_FRAGMENT_DEFAULTS['platform.language']}\n命令技能在 /s 下`,
    );
  });

  it('findInvalidFragmentVariables：只允许 skills_dir，片段里不能再引用片段', () => {
    expect(findInvalidFragmentVariables('a {{skills_dir}} b')).toEqual([]);
    expect(
      findInvalidFragmentVariables(
        '{{foo}} {{platform.language}} {{foo}} {{skills_dir}}',
      ),
    ).toEqual(['foo', 'platform.language']);
  });

  it('isPromptFragmentId 只认内置 4 个', () => {
    expect(isPromptFragmentId('platform.language')).toBe(true);
    expect(isPromptFragmentId('platform.nope')).toBe(false);
  });
});
