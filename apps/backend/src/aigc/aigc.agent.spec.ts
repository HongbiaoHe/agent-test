import {
  agentDerivedDims,
  audioReferenceIssues,
  describeConstraint,
  NO_REFERENCES,
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

/** 参考素材计数：图 / 视频 / 音频 */
const refs = (image: number, video = 0, audio = 0) => ({ image, video, audio });

describe('validateAgentRequest', () => {
  const base = { prompt: 'p', referenceCounts: NO_REFERENCES, derived: {} };

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
    const derived = agentDerivedDims('video', 'veo-3.1', refs(1));
    const r = validateAgentRequest(veo, {
      prompt: 'p',
      referenceCounts: refs(1),
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
      derived: agentDerivedDims('video', 'minimax-h3', NO_REFERENCES),
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
      referenceCounts: refs(4),
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
      referenceCounts: refs(1),
      params: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('不支持参考图');
  });

  it('参考视频 / 音频按各自上限校验：不支持的类型报错，图片不受影响', () => {
    const seedance = aigcModelSchema.parse({
      model_alias: 'seedance-2',
      type: 'video',
      image_input_number: 9,
      video_input_number: 3,
      audio_input_number: 3,
    });
    expect(
      validateAgentRequest(seedance, {
        ...base,
        referenceCounts: refs(2, 3, 1),
        params: {},
      }).ok,
    ).toBe(true);

    const over = validateAgentRequest(seedance, {
      ...base,
      referenceCounts: refs(1, 4, 0),
      params: {},
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.issues).toHaveLength(1);
    expect(over.issues[0].message).toContain('最多 3 个参考视频，传了 4 个');

    // veo 只收图：带一段音频即报「不支持参考音频」
    const veoAudio = validateAgentRequest(veo, {
      ...base,
      referenceCounts: refs(1, 0, 1),
      params: {},
    });
    expect(veoAudio.ok).toBe(false);
    if (veoAudio.ok) return;
    expect(veoAudio.issues[0].message).toContain('不支持参考音频');
  });
});

describe('agentDerivedDims', () => {
  it('按类型推出 input_has_*：只有图挂首帧（i2v-only 模型），视频 / 音频恒为 reference', () => {
    expect(agentDerivedDims('video', 'seedance-2', refs(0, 1, 1))).toEqual({
      input_has_image: 'no',
      input_has_video: 'yes',
      input_has_audio: 'yes',
      input_has_frame_control: 'no',
    });
    expect(
      agentDerivedDims('video', 'seedance-1.5-pro', refs(1))
        .input_has_frame_control,
    ).toBe('yes');
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

/** 夹具取自 2026-10-24 实测 aigc 目录 GET /channels?type=audio（只保留用到的维度）。 */
const minimaxSpeech = aigcModelSchema.parse({
  model_alias: 'minimax-speech-2.8-hd',
  type: 'audio',
  max_prompt: 10000,
  params: [
    {
      param_type: 'voice_id',
      input: 'required',
      options: [
        { label: '智慧女声', value: 'Wise_Woman' },
        { label: '沉静女声', value: 'Calm_Woman' },
      ],
    },
    {
      param_type: 'speed',
      input: 'optional',
      value_type: 'range',
      options: [],
      range: { min: 0.5, max: 2, step: 0.1 },
    },
    {
      param_type: 'english_normalization',
      input: 'optional',
      value_type: 'boolean',
      options: [],
    },
  ],
});

describe('音频：区间维度与参考规则', () => {
  const base = { prompt: '你好', referenceCounts: NO_REFERENCES, derived: {} };

  it('合法区间值并入结果，必填 voice_id 自动补第一个', () => {
    expect(
      validateAgentRequest(minimaxSpeech, {
        ...base,
        params: { speed: '1.2' },
      }),
    ).toEqual({ ok: true, params: { voice_id: 'Wise_Woman', speed: '1.2' } });
  });

  it('区间越界或不合步长 → 报错并给出区间', () => {
    const r = validateAgentRequest(minimaxSpeech, {
      ...base,
      params: { speed: '3' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({
      field: 'params.speed',
      value: '3',
      allowed: ['0.5~2'],
    });
    expect(r.issues[0].message).toContain('步长 0.1');
  });

  it('minimax 不收参考音频 → 报错', () => {
    const r = validateAgentRequest(minimaxSpeech, {
      ...base,
      params: {},
      referenceCounts: refs(0, 0, 1),
    });
    expect(r.ok).toBe(false);
  });

  it('toAgentCatalog：区间维度给 range/step，布尔维度不出现', () => {
    const view = toAgentCatalog('audio', [
      { channel: 'fal', models: [minimaxSpeech] },
    ]);
    expect(view.models[0].params).toEqual({
      voice_id: { required: true, values: ['Wise_Woman', 'Calm_Woman'] },
      speed: { required: false, range: [0.5, 2], step: 0.1 },
    });
    expect(view.note).toContain('range');
  });

  it('audioReferenceIssues：图音混传报错，单类不报', () => {
    expect(audioReferenceIssues(refs(1, 0, 1))).toHaveLength(1);
    expect(audioReferenceIssues(refs(0, 0, 3))).toEqual([]);
    expect(audioReferenceIssues(refs(1))).toEqual([]);
  });
});
