import {
  AgentModeInputSchema,
  AgentModeSchema,
  GENERAL_MODE_PROMPT,
  GeneralModeSettingsSchema,
} from './mode.schema';

describe('AgentModeInputSchema', () => {
  it('合法输入：name 去空白、数组默认空、默认模型可空', () => {
    const v = AgentModeInputSchema.parse({ name: ' 生图 ', systemPrompt: 'x' });
    expect(v).toEqual({
      name: '生图',
      systemPrompt: 'x',
      toolNames: [],
      mcpServerIds: [],
      skillNames: [],
      defaultModel: null,
      defaultThinkingLevel: null,
    });
  });

  it('name 空 / systemPrompt 空 / 超长都拒绝', () => {
    expect(() =>
      AgentModeInputSchema.parse({ name: '  ', systemPrompt: 'x' }),
    ).toThrow();
    expect(() =>
      AgentModeInputSchema.parse({ name: 'a', systemPrompt: '' }),
    ).toThrow();
    expect(() =>
      AgentModeInputSchema.parse({
        name: 'a',
        systemPrompt: 'x'.repeat(100_001),
      }),
    ).toThrow();
  });

  it('AgentModeSchema 要求 id', () => {
    expect(() =>
      AgentModeSchema.parse({ name: 'a', systemPrompt: 'x' }),
    ).toThrow();
    expect(
      AgentModeSchema.parse({ id: 'm1', name: 'a', systemPrompt: 'x' }).id,
    ).toBe('m1');
  });

  it('通用模式提示词只引用四个平台片段', () => {
    const ids = [
      ...GENERAL_MODE_PROMPT.matchAll(/\{\{\s*([a-z_.]+)\s*\}\}/g),
    ].map((m) => m[1]);
    expect(ids).toEqual([
      'platform.language',
      'platform.slash_command',
      'platform.skill_loading',
      'platform.injection_guard',
    ]);
  });
});

describe('GeneralModeSettingsSchema', () => {
  it('全部可空，缺省为 null（= 用默认提示词、不回填模型）', () => {
    expect(GeneralModeSettingsSchema.parse({})).toEqual({
      systemPrompt: null,
      defaultModel: null,
      defaultThinkingLevel: null,
    });
  });

  it('提示词给了就不能是空串', () => {
    expect(() =>
      GeneralModeSettingsSchema.parse({ systemPrompt: '' }),
    ).toThrow();
    expect(
      GeneralModeSettingsSchema.parse({ systemPrompt: 'x' }).systemPrompt,
    ).toBe('x');
  });
});
