import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
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

  it('子文件也要求带 limit 读取（默认 100 行会截断）', async () => {
    const text = await buildSkillPrompt(['/docx a', '继续'], lookup, '/s');
    expect(text).toContain('limit=1000');
  });

  describe('重放的上下文里已有完整读取 → 不重复注入', () => {
    const readCall = (args: Record<string, unknown>, withResult = true) => [
      new HumanMessage('/docx 写周报'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'r1', name: 'read_file', args, type: 'tool_call' }],
      }),
      ...(withResult
        ? [
            new ToolMessage({
              tool_call_id: 'r1',
              name: 'read_file',
              content: '1\t# Docx',
            }),
          ]
        : []),
      new HumanMessage('再改短一点'),
    ];
    const build = (context: ReturnType<typeof readCall>) =>
      buildSkillPrompt(
        ['/docx 写周报', '再改短一点'],
        lookup,
        '/workspace/skills',
        context,
      );

    it('读全了（limit 覆盖全文）→ 不注入', async () => {
      expect(
        await build(
          readCall({
            file_path: '/workspace/skills/docx/SKILL.md',
            limit: 1000,
          }),
        ),
      ).toBe('');
      // 短文件不传 limit 也算读全（默认 100 行够用）
      expect(
        await build(readCall({ file_path: '/workspace/skills/docx/SKILL.md' })),
      ).toBe('');
    });

    it('只读了一部分（从中间读 / limit 不够）、只有调用没有结果、读的是别的文件 → 照常注入', async () => {
      const long = {
        ...md,
        docx: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'),
      };
      const longText = await buildSkillPrompt(
        ['/docx 写周报', '再改短一点'],
        (n) => long[n] ?? null,
        '/workspace/skills',
        readCall({ file_path: '/workspace/skills/docx/SKILL.md' }),
      );
      expect(longText).toContain('## 已加载技能：docx');
      expect(
        await build(
          readCall({
            file_path: '/workspace/skills/docx/SKILL.md',
            offset: 50,
            limit: 1000,
          }),
        ),
      ).toContain('已加载技能');
      expect(
        await build(
          readCall(
            { file_path: '/workspace/skills/docx/SKILL.md', limit: 1000 },
            false,
          ),
        ),
      ).toContain('已加载技能');
      expect(
        await build(
          readCall({
            file_path: '/workspace/skills/pdf/SKILL.md',
            limit: 1000,
          }),
        ),
      ).toContain('已加载技能');
    });
  });
});
