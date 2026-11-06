import { injectSkillReadPolicy, SKILL_READ_POLICY } from './plan-injection';

describe('injectSkillReadPolicy', () => {
  it('无条件把引用必读规则 concat 到 systemMessage 末尾', () => {
    const concat = jest.fn((s: string) => ({ concated: s }));
    const handler = jest.fn((req: unknown) => req);

    injectSkillReadPolicy({ systemMessage: { concat } }, handler);

    expect(concat).toHaveBeenCalledTimes(1);
    expect(concat.mock.calls[0][0]).toContain(SKILL_READ_POLICY);
    expect(concat.mock.calls[0][0]).toContain('引用文件必读');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
