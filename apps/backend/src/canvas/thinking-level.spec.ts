import {
  supportsThinkingLevel,
  thinkingLevelsFor,
  thinkingModelParams,
} from './thinking-level';

describe('thinkingLevelsFor', () => {
  it('DeepSeek 只给开/关：实测 reasoningEffort 无效，不能暴露假的分级选项', () => {
    expect(thinkingLevelsFor('deepseek:deepseek-flash')).toEqual([
      'auto',
      'off',
      'on',
    ]);
  });

  it('Gemini 分级全模型可用，但不支持关闭的模型不给 off（传 budget:0 会 400）', () => {
    // 实测 400：3.1-pro-preview / 3.5-flash-lite / 3.6-flash
    expect(thinkingLevelsFor('gemini-3.1-pro-preview')).toEqual([
      'auto',
      'low',
      'medium',
      'high',
    ]);
    expect(thinkingLevelsFor('gemini-3.6-flash')).not.toContain('off');
  });

  it('实测支持关闭的 Gemini 才给 off 档', () => {
    expect(thinkingLevelsFor('gemini-3.5-flash')).toEqual([
      'auto',
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(thinkingLevelsFor('gemini-3-flash-preview')).toContain('off');
  });

  it('未知/新增 Gemini 模型默认不给 off —— 少个选项好过整轮跑挂在 400', () => {
    expect(thinkingLevelsFor('gemini-9.9-future')).toEqual([
      'auto',
      'low',
      'medium',
      'high',
    ]);
  });

  it('裸 gemini 名与 google-genai: 前缀同样按 Gemini 处理（与 factory 的解析一致）', () => {
    expect(thinkingLevelsFor('google-genai:gemini-3.5-flash')).toEqual(
      thinkingLevelsFor('gemini-3.5-flash'),
    );
    // 前缀不能干扰 off 白名单的匹配
    expect(thinkingLevelsFor('google-genai:gemini-3.5-flash')).toContain('off');
  });
});

describe('thinkingModelParams', () => {
  const DS = 'deepseek:deepseek-flash';
  const GM = 'gemini-3.1-pro-preview'; // 支持分级、不支持关闭

  it('DeepSeek off → thinking.disabled（唯一实测稳定生效的开关）', () => {
    expect(thinkingModelParams(DS, 'off')).toEqual({
      modelKwargs: { thinking: { type: 'disabled' } },
    });
  });

  it('DeepSeek on → thinking.enabled', () => {
    expect(thinkingModelParams(DS, 'on')).toEqual({
      modelKwargs: { thinking: { type: 'enabled' } },
    });
  });

  it('DeepSeek auto → 不传任何参数（完全跟随模型默认）', () => {
    expect(thinkingModelParams(DS, 'auto')).toEqual({});
    expect(thinkingModelParams(DS, null)).toEqual({});
  });

  it('Gemini 分级 → thinkingLevel + includeThoughts（思考内容要可见）', () => {
    expect(thinkingModelParams(GM, 'low')).toEqual({
      thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true },
    });
    expect(thinkingModelParams(GM, 'high')).toEqual({
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
    });
  });

  it('支持关闭的 Gemini：off → thinkingBudget 0', () => {
    expect(thinkingModelParams('gemini-3.5-flash', 'off')).toEqual({
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('不支持关闭的 Gemini 收到 off（DB 里的旧值）→ 回落 auto，不发 budget:0 触 400', () => {
    // 用户实测踩到的就是这条：gemini-3.6-flash + off → 400 Bad Request
    expect(thinkingModelParams('gemini-3.6-flash', 'off')).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
  });

  it('Gemini auto → 不定档位但打开 includeThoughts（否则思考面板永远空着）', () => {
    expect(thinkingModelParams(GM, 'auto')).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
  });

  it('档位与模型不匹配（换过模型的旧会话）→ 静默回落 auto，不抛错', () => {
    // 'high' 是 Gemini 档位，DeepSeek 上无效
    expect(thinkingModelParams(DS, 'high')).toEqual({});
    // 'on' 是 DeepSeek 档位，Gemini 上无效
    expect(thinkingModelParams(GM, 'on')).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
    expect(supportsThinkingLevel(DS, 'high')).toBe(false);
    expect(supportsThinkingLevel(GM, 'on')).toBe(false);
  });
});
