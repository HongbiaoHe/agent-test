import {
  agentDerivedDims,
  describeConstraint,
  resolveAgentModel,
  toAgentCatalog,
  validateAgentRequest,
} from './aigc.agent';
import { aigcModelSchema, type AigcChannel } from './aigc.types';

/** 夹具取自 2026-10-18 实测 aigc 目录（只保留用到的维度）。 */
const veo = aigcModelSchema.parse({
  model_alias: 'veo-3.1',
  display_name: 'Veo 3.1',
  type: 'video',
  max_prompt: 100,
  image_input_number: 3,
  params: [
    {
      param_type: 'aspect_ratio',
      input: 'required',
      options: [
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
      ],
    },
    {
      param_type: 'duration',
      input: 'required',
      options: ['4', '6', '8'].map((v) => ({ label: `${v}s`, value: v })),
    },
    {
      param_type: 'resolution',
      input: 'required',
      options: ['720p', '1080p', '4k'].map((v) => ({ label: v, value: v })),
    },
    {
      param_type: 'input_has_image',
      input: 'derived',
      options: [
        { label: 'yes', value: 'yes' },
        { label: 'no', value: 'no' },
      ],
    },
  ],
  constraints: [
    { when: { resolution: ['1080p', '4k'] }, allow: { duration: ['8'] } },
    { when: { input_has_image: ['yes'] }, allow: { duration: ['8'] } },
  ],
});

const minimax = aigcModelSchema.parse({
  model_alias: 'minimax-h3',
  type: 'video',
  image_input_number: 9,
  params: [
    {
      param_type: 'duration',
      input: 'required',
      options: [{ label: '5s', value: '5' }],
    },
    {
      param_type: 'aspect_ratio',
      input: 'optional',
      options: ['adaptive', '16:9'].map((v) => ({ label: v, value: v })),
    },
    {
      param_type: 'with_audio',
      input: 'optional',
      options: ['true', 'false'].map((v) => ({ label: v, value: v })),
    },
  ],
  constraints: [
    { when: { input_has_frame_control: ['yes'] }, forbid: ['aspect_ratio'] },
    { when: { input_has_image: ['yes', 'no'] }, forbid: ['with_audio'] },
  ],
});

const gpt = aigcModelSchema.parse({
  model_alias: 'gpt-image-2',
  display_name: 'GPT-image-2',
  type: 'image',
  image_input_number: 0,
  params: [
    {
      param_type: 'aspect_ratio',
      input: 'required',
      options: ['1x1', '16x9'].map((v) => ({ label: v, value: v })),
    },
  ],
});

const channels: AigcChannel[] = [
  { channel: 'google', models: [veo] },
  { channel: 'fal', models: [minimax, gpt] },
  { channel: 'kie', models: [gpt] },
];

describe('validateAgentRequest', () => {
  const base = { prompt: 'p', referenceCount: 0, derived: {} };

  it('全部合法 → ok，未传的必填维度补第一个取值', () => {
    const r = validateAgentRequest(veo, {
      ...base,
      params: { aspect_ratio: '9:16' },
    });
    expect(r).toEqual({
      ok: true,
      params: { aspect_ratio: '9:16', duration: '4', resolution: '720p' },
    });
  });

  it('取值不在 options → 报错并给出可选值', () => {
    const r = validateAgentRequest(gpt, {
      ...base,
      params: { aspect_ratio: '16:9' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      expect.objectContaining({
        field: 'params.aspect_ratio',
        value: '16:9',
        allowed: ['1x1', '16x9'],
      }),
    ]);
  });

  it('未知维度、derived 维度 → 报错', () => {
    const r = validateAgentRequest(veo, {
      ...base,
      params: { fps: '30', input_has_image: 'yes' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field)).toEqual([
      'params.fps',
      'params.input_has_image',
    ]);
    expect(r.issues[1].message).toContain('自动推导');
  });

  it('显式值违反 constraints（veo 1080p + 4 秒）→ 报错，allowed=[8]', () => {
    const r = validateAgentRequest(veo, {
      ...base,
      params: { resolution: '1080p', duration: '4' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      field: 'params.duration',
      value: '4',
      allowed: ['8'],
    });
    expect(r.issues[0].message).toContain('resolution=1080p/4k');
  });

  it('自动补的值违反 constraints → 静默换成允许值（不报错）', () => {
    const r = validateAgentRequest(veo, {
      ...base,
      params: { resolution: '4k' },
    });
    expect(r).toEqual({
      ok: true,
      params: { aspect_ratio: '16:9', duration: '8', resolution: '4k' },
    });
  });

  it('constraints 依赖 derived：带参考图时 veo 只能 8 秒', () => {
    const derived = agentDerivedDims('video', 'veo-3.1', 1);
    const r = validateAgentRequest(veo, {
      prompt: 'p',
      referenceCount: 1,
      derived,
      params: { duration: '6' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('带参考图');
  });

  it('forbid：显式传被禁维度报错；无条件 forbid 的说明为「任何情况下」', () => {
    const r = validateAgentRequest(minimax, {
      ...base,
      derived: agentDerivedDims('video', 'minimax-h3', 0),
      params: { with_audio: 'true' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ field: 'params.with_audio' });
    expect(r.issues[0].message).toContain('任何情况下');
  });

  it('提示词超长、参考图超量 → 报错', () => {
    const r = validateAgentRequest(veo, {
      prompt: 'x'.repeat(101),
      referenceCount: 4,
      derived: {},
      params: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.field)).toEqual([
      'prompt',
      'referenceVersionIds',
    ]);
  });

  it('不支持参考图的模型传参考图 → 报错', () => {
    const r = validateAgentRequest(gpt, {
      ...base,
      referenceCount: 1,
      params: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('不支持参考图');
  });
});

describe('resolveAgentModel', () => {
  it('不传 → 目录第一个', () => {
    const r = resolveAgentModel(channels, {});
    expect('model' in r && r.model.model_alias).toBe('veo-3.1');
  });

  it('精确别名；同名多渠道取第一个，可用 channel 指定', () => {
    const a = resolveAgentModel(channels, { model: 'gpt-image-2' });
    expect('channel' in a && a.channel).toBe('fal');
    const b = resolveAgentModel(channels, {
      model: 'gpt-image-2',
      channel: 'kie',
    });
    expect('channel' in b && b.channel).toBe('kie');
  });

  it('宽松匹配：大小写/空格/展示名', () => {
    const r = resolveAgentModel(channels, { model: 'Veo 3.1' });
    expect('model' in r && r.model.model_alias).toBe('veo-3.1');
  });

  it('找不到 → issue 带可选模型列表（去重）', () => {
    const r = resolveAgentModel(channels, { model: 'dall-e-3' });
    expect('issue' in r && r.issue.allowed).toEqual([
      'veo-3.1',
      'minimax-h3',
      'gpt-image-2',
    ]);
  });
});

describe('toAgentCatalog', () => {
  it('精简视图：首个标 default、去掉 derived 维度、constraints 译成规则', () => {
    const view = toAgentCatalog('video', channels);
    expect(view.models[0]).toMatchObject({
      model: 'veo-3.1',
      channel: 'google',
      default: true,
      maxPromptChars: 100,
      maxReferenceImages: 3,
    });
    expect(Object.keys(view.models[0].params)).toEqual([
      'aspect_ratio',
      'duration',
      'resolution',
    ]);
    expect(view.models[0].params.duration).toEqual({
      required: true,
      values: ['4', '6', '8'],
    });
    expect(view.models[0].rules).toEqual([
      'resolution=1080p/4k：duration 只能取 8',
      '带参考图：duration 只能取 8',
    ]);
    expect(view.models[1].default).toBeUndefined();
  });

  it('describeConstraint 写出 forbid', () => {
    expect(describeConstraint(minimax.constraints[0])).toBe(
      '使用首尾帧：不能传 aspect_ratio',
    );
  });
});
