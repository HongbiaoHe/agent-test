import { askUserTool } from './ask-user.tool';

/** 构造一个合法单选题，over 覆盖字段用于制造非法输入 */
const q = (over: Partial<Record<string, unknown>> = {}) => ({
  question: '用哪个数据库？',
  header: '数据库',
  multiSelect: false,
  options: [{ label: 'Postgres' }, { label: 'MySQL' }],
  suggested: ['Postgres'],
  ...over,
});

describe('askUserTool', () => {
  it('approve 路径：执行返回全部建议答案且标记 auto', async () => {
    const raw = await askUserTool.invoke({ questions: [q()] });
    const parsed = JSON.parse(raw) as {
      answers: {
        header: string;
        question: string;
        selected: string[];
        auto: boolean;
      }[];
    };
    expect(parsed.answers).toEqual([
      {
        header: '数据库',
        question: '用哪个数据库？',
        selected: ['Postgres'],
        auto: true,
      },
    ]);
  });

  // 语义问题不硬校验（HITL 中断在 zod 校验之前，refine 只会炸在续跑），改为归一化：
  it('suggested 不在 options 中 → 归一化回退到首选项', async () => {
    const raw = await askUserTool.invoke({
      questions: [q({ suggested: ['SQLite'] })],
    });
    const parsed = JSON.parse(raw) as { answers: { selected: string[] }[] };
    expect(parsed.answers[0].selected).toEqual(['Postgres']);
  });

  it('单选题 suggested 多于 1 个 → 归一化只取第一个', async () => {
    const raw = await askUserTool.invoke({
      questions: [q({ suggested: ['MySQL', 'Postgres'] })],
    });
    const parsed = JSON.parse(raw) as { answers: { selected: string[] }[] };
    expect(parsed.answers[0].selected).toEqual(['MySQL']);
  });

  it('多选题 suggested 可以多个', async () => {
    const raw = await askUserTool.invoke({
      questions: [q({ multiSelect: true, suggested: ['Postgres', 'MySQL'] })],
    });
    const parsed = JSON.parse(raw) as { answers: { selected: string[] }[] };
    expect(parsed.answers[0].selected).toEqual(['Postgres', 'MySQL']);
  });

  it('模型超发题数/选项数不报错（结构上限不硬卡，防炸续跑）', async () => {
    const many = {
      ...q(),
      options: [
        { label: 'A' },
        { label: 'B' },
        { label: 'C' },
        { label: 'D' },
        { label: 'E' },
        { label: 'F' },
        { label: 'G' },
      ],
      suggested: ['A'],
    };
    const raw = await askUserTool.invoke({
      questions: [many, q(), q(), q(), q()],
    });
    const parsed = JSON.parse(raw) as { answers: { selected: string[] }[] };
    expect(parsed.answers).toHaveLength(5);
    expect(parsed.answers[0].selected).toEqual(['A']);
  });

  it('edit 路径：带 answers（用户答案）时原样返回且 auto:false', async () => {
    const raw = await askUserTool.invoke({
      questions: [q()],
      answers: [{ header: '数据库', selected: ['MySQL', '自定义：用 SQLite'] }],
    });
    const parsed = JSON.parse(raw) as {
      answers: { header: string; selected: string[]; auto: boolean }[];
    };
    expect(parsed.answers).toEqual([
      {
        header: '数据库',
        selected: ['MySQL', '自定义：用 SQLite'],
        auto: false,
      },
    ]);
  });
});
