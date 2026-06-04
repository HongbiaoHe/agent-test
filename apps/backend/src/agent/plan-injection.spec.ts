import {
  injectActivePlan,
  injectSkillReadPolicy,
  SKILL_READ_POLICY,
} from './plan-injection';

describe('injectActivePlan', () => {
  it('有 activePlan 时把它 concat 到 systemMessage 末尾再交给 handler', () => {
    const concat = jest.fn((s: string) => ({ concated: s }));
    const handler = jest.fn((req: unknown) => req);
    const request = {
      systemMessage: { concat },
      runtime: { context: { activePlan: 'PLAN-X' } },
    };

    injectActivePlan(request, handler);

    expect(concat).toHaveBeenCalledTimes(1);
    expect(concat.mock.calls[0][0]).toContain('PLAN-X');
    const passed = handler.mock.calls[0][0] as { systemMessage: unknown };
    expect(passed.systemMessage).toEqual({ concated: '\n\nPLAN-X' });
  });

  it('无 activePlan（空串/缺失）时原样透传，不改 systemMessage', () => {
    const concat = jest.fn();
    const handler = jest.fn((req: unknown) => req);

    injectActivePlan({ systemMessage: { concat }, runtime: { context: {} } }, handler);
    injectActivePlan({ systemMessage: { concat }, runtime: { context: { activePlan: '' } } }, handler);
    injectActivePlan({ systemMessage: { concat } }, handler);

    expect(concat).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

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
