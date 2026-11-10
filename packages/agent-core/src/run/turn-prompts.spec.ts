import { buildActivePlan, buildSkillPrompt } from './turn-prompts';

describe('buildActivePlan', () => {
  it('没有计划 / 空列表 / 形状不对 → 空串', () => {
    expect(buildActivePlan(null)).toBe('');
    expect(buildActivePlan({ todos: [] })).toBe('');
    expect(buildActivePlan({ todos: 'x' })).toBe('');
  });

  it('列出既有步骤与状态，并要求继续执行、不重新拆解', () => {
    const text = buildActivePlan({
      todos: [
        { content: '写代码', status: 'completed' },
        { content: '跑测试', status: 'in_progress' },
      ],
    });
    expect(text).toContain('## 当前任务计划（已存在，继续执行，请勿重新拆解）');
    expect(text).toContain('1. [completed] 写代码\n2. [in_progress] 跑测试');
    expect(text).toContain('不要把整张列表替换成新的');
  });
});

describe('buildSkillPrompt', () => {
  const md: Record<string, string> = {
    docx: '# Docx\n见 `./references/a.md`',
    pdf: '# Pdf',
  };
  const lookup = (name: string) => md[name] ?? null;

  it('之前轮次激活过技能 → 注入 SKILL.md 全文（相对引用改成绝对路径），并要求别再 read_file', async () => {
    const text = await buildSkillPrompt(
      ['/docx 写周报', '再改短一点'],
      lookup,
      '/workspace/skills',
    );
    expect(text).toContain('## 已加载技能：docx');
    expect(text).toContain(
      '不要再 read_file 读取 `/workspace/skills/docx/SKILL.md`',
    );
    expect(text).toContain('`/workspace/skills/docx/references/a.md`');
  });

  it('本轮才首次发起 /command → 不注入（交给 read_file 首次加载）', async () => {
    expect(await buildSkillPrompt(['你好', '/docx 写周报'], lookup, '/s')).toBe(
      '',
    );
  });

  it('多次激活取最近一个；查不到的 /名字（模式外 / 未安装）当普通文本', async () => {
    const text = await buildSkillPrompt(
      ['/docx a', '/pdf b', '/unknown c', '继续'],
      (name) => Promise.resolve(lookup(name)),
      '/s',
    );
    expect(text).toContain('## 已加载技能：pdf');
    expect(await buildSkillPrompt(['/unknown a', '继续'], lookup, '/s')).toBe(
      '',
    );
  });

  it('没有用户消息 → 空串', async () => {
    expect(await buildSkillPrompt([], lookup, '/s')).toBe('');
  });
});
