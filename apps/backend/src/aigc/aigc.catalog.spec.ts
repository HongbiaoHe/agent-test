/**
 * aigc.catalog 单元测试（全是纯函数，不打网络）：
 * - defaultConfig：默认取目录第一个模型 + 各必填维度第一个取值
 * - sanitizeParams：丢无效维度、补必填、按 constraints 收窄（allow 求交 / forbid 删维度）
 * - buildTaskBody：param_type → 请求字段的映射与类型（duration → duration_seconds 整数等）
 * - videoRefRole：按渠道决定参考图挂 first_frame 还是 reference
 *
 * 用例里的模型形状照实测的 GET /channels 返回裁剪（seedream-4.5 / veo-3.1 / minimax-h3）。
 */
import {
  buildTaskBody,
  defaultConfig,
  derivedDims,
  sanitizeParams,
  taskPath,
  videoRefRole,
} from './aigc.catalog';
import type { AigcChannel, AigcModel } from './aigc.types';

const seedream: AigcModel = {
  model_alias: 'seedream-4.5',
  type: 'image',
  image_input_number: 14,
  video_input_number: 0,
  audio_input_number: 0,
  params: [
    {
      param_type: 'aspect_ratio',
      input: 'required',
      options: [
        { label: '16:9', value: '16:9' },
        { label: '1:1', value: '1:1' },
      ],
    },
    {
      param_type: 'resolution',
      input: 'required',
      options: [
        { label: '2K', value: '2K' },
        { label: '4K', value: '4K' },
      ],
    },
  ],
  constraints: [],
};

/** veo-3.1：选 1080p/4k 或带了参考图 → 时长只能 8 秒（allow 收窄，两条规则都可能命中）。 */
const veo: AigcModel = {
  model_alias: 'veo-3.1',
  type: 'video',
  image_input_number: 3,
  video_input_number: 0,
  audio_input_number: 0,
  params: [
    {
      param_type: 'duration',
      input: 'required',
      options: [
        { label: '4s', value: '4' },
        { label: '6s', value: '6' },
        { label: '8s', value: '8' },
      ],
    },
    {
      param_type: 'resolution',
      input: 'required',
      options: [
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' },
      ],
    },
    {
      param_type: 'input_has_image',
      input: 'derived',
      options: [
        { label: '是', value: 'yes' },
        { label: '否', value: 'no' },
      ],
    },
  ],
  constraints: [
    { when: { resolution: ['1080p', '4k'] }, allow: { duration: ['8'] } },
    { when: { input_has_image: ['yes'] }, allow: { duration: ['8'] } },
  ],
};

/** minimax-h3：接了首帧就禁 aspect_ratio；with_audio 无条件禁传。 */
const minimax: AigcModel = {
  model_alias: 'minimax-h3',
  type: 'video',
  image_input_number: 9,
  video_input_number: 0,
  audio_input_number: 0,
  params: [
    {
      param_type: 'aspect_ratio',
      input: 'optional',
      options: [
        { label: '16:9', value: '16:9' },
        { label: 'adaptive', value: 'adaptive' },
      ],
    },
    {
      param_type: 'with_audio',
      input: 'optional',
      options: [
        { label: '开', value: 'true' },
        { label: '关', value: 'false' },
      ],
    },
    {
      param_type: 'input_has_image',
      input: 'derived',
      options: [
        { label: '是', value: 'yes' },
        { label: '否', value: 'no' },
      ],
    },
    {
      param_type: 'input_has_frame_control',
      input: 'derived',
      options: [
        { label: '是', value: 'yes' },
        { label: '否', value: 'no' },
      ],
    },
  ],
  constraints: [
    { when: { input_has_frame_control: ['yes'] }, forbid: ['aspect_ratio'] },
    { when: { input_has_image: ['yes', 'no'] }, forbid: ['with_audio'] },
  ],
};

describe('defaultConfig', () => {
  it('取第一个渠道的第一个模型 + 各必填维度第一个取值', () => {
    const channels: AigcChannel[] = [
      { channel: 'byteplus', models: [seedream] },
      { channel: 'google', models: [veo] },
    ];
    expect(defaultConfig(channels)).toEqual({
      channel: 'byteplus',
      model: 'seedream-4.5',
      params: { aspect_ratio: '16:9', resolution: '2K' },
    });
  });

  it('目录为空 → null', () => expect(defaultConfig([])).toBeNull());

  it('跳过没有模型的渠道', () => {
    const r = defaultConfig([
      { channel: 'fal', models: [] },
      { channel: 'byteplus', models: [seedream] },
    ]);
    expect(r?.channel).toBe('byteplus');
  });
});

describe('sanitizeParams', () => {
  it('非法取值的必填维度回落第一个取值', () => {
    expect(sanitizeParams(seedream, { resolution: '8K' })).toEqual({
      aspect_ratio: '16:9',
      resolution: '2K',
    });
  });

  it('丢掉模型没有的维度与 derived 维度', () => {
    expect(
      sanitizeParams(seedream, {
        aspect_ratio: '1:1',
        resolution: '4K',
        duration: '8',
        input_has_image: 'yes',
      }),
    ).toEqual({ aspect_ratio: '1:1', resolution: '4K' });
  });

  it('allow 收窄：1080p 时把时长夹到 8 秒', () => {
    expect(sanitizeParams(veo, { duration: '4', resolution: '1080p' })).toEqual(
      { duration: '8', resolution: '1080p' },
    );
  });

  it('allow 收窄：带参考图（derived）时同样夹到 8 秒', () => {
    expect(
      sanitizeParams(
        veo,
        { duration: '4', resolution: '720p' },
        {
          input_has_image: 'yes',
        },
      ),
    ).toEqual({ duration: '8', resolution: '720p' });
  });

  it('未命中约束时保留用户选的值', () => {
    expect(
      sanitizeParams(
        veo,
        { duration: '4', resolution: '720p' },
        {
          input_has_image: 'no',
        },
      ),
    ).toEqual({ duration: '4', resolution: '720p' });
  });

  it('forbid：接了首帧则删掉 aspect_ratio，with_audio 无条件删', () => {
    expect(
      sanitizeParams(
        minimax,
        { aspect_ratio: '16:9', with_audio: 'true' },
        { input_has_image: 'yes', input_has_frame_control: 'yes' },
      ),
    ).toEqual({});
  });

  it('forbid 只作用于命中的维度：没首帧时 aspect_ratio 仍可传', () => {
    expect(
      sanitizeParams(
        minimax,
        { aspect_ratio: '16:9', with_audio: 'true' },
        { input_has_image: 'no', input_has_frame_control: 'no' },
      ),
    ).toEqual({ aspect_ratio: '16:9' });
  });
});

describe('derivedDims', () => {
  it('按参考资源算 has_* 与首帧控制', () => {
    expect(
      derivedDims([
        { type: 'image', role: 'first_frame', url: 'https://x/a.png' },
      ]),
    ).toEqual({
      input_has_image: 'yes',
      input_has_video: 'no',
      input_has_audio: 'no',
      input_has_frame_control: 'yes',
    });
  });

  it('无参考资源时全 no', () => {
    expect(derivedDims([])).toEqual({
      input_has_image: 'no',
      input_has_video: 'no',
      input_has_audio: 'no',
      input_has_frame_control: 'no',
    });
  });
});

describe('buildTaskBody', () => {
  it('图片：档位映射到 aspect_ratio / resolution，带回调与参考图', () => {
    expect(
      buildTaskBody({
        type: 'image',
        prompt: 'a corgi',
        config: {
          channel: 'byteplus',
          model: 'seedream-4.5',
          params: { aspect_ratio: '16:9', resolution: '2K' },
        },
        references: [
          { type: 'image', role: 'reference', url: 'https://x/a.png' },
        ],
        callbackUrl: 'https://me/media/aigc/callback',
        metadata: { versionId: 'v1' },
      }),
    ).toEqual({
      prompt: 'a corgi',
      channel: 'byteplus',
      model: 'seedream-4.5',
      aspect_ratio: '16:9',
      resolution: '2K',
      reference_resources: [
        { type: 'image', role: 'reference', url: 'https://x/a.png' },
      ],
      callback_url: 'https://me/media/aigc/callback',
      metadata: { versionId: 'v1' },
    });
  });

  it('视频：duration → duration_seconds（整数）、with_audio → 布尔', () => {
    const body = buildTaskBody({
      type: 'video',
      prompt: 'a drone shot',
      config: {
        channel: 'byteplus',
        model: 'seedance-2',
        params: { duration: '5', with_audio: 'true', resolution: '720p' },
      },
      references: [],
    });
    expect(body.duration_seconds).toBe(5);
    expect(body.with_audio).toBe(true);
    expect(body.resolution).toBe('720p');
    // 没有参考图 / 回调 / metadata 时不带这些键（请求体是严格白名单）
    expect(body).not.toHaveProperty('reference_resources');
    expect(body).not.toHaveProperty('callback_url');
    expect(body).not.toHaveProperty('metadata');
  });

  it('认不出的维度直接丢掉（多传一个字段整单会被拒）', () => {
    const body = buildTaskBody({
      type: 'image',
      prompt: 'x',
      config: {
        channel: 'google',
        model: 'nano-banana',
        params: { aspect_ratio: '1:1', mystery_dim: 'whatever' },
      },
      references: [],
    });
    expect(body).toEqual({
      prompt: 'x',
      channel: 'google',
      model: 'nano-banana',
      aspect_ratio: '1:1',
    });
  });
});

describe('videoRefRole / taskPath', () => {
  it('byteplus / fal 用首帧，其余用 reference', () => {
    expect(videoRefRole('byteplus')).toBe('first_frame');
    expect(videoRefRole('fal')).toBe('first_frame');
    expect(videoRefRole('google')).toBe('reference');
    expect(videoRefRole('kie')).toBe('reference');
  });

  it('接单路径按类型', () => {
    expect(taskPath('image')).toBe('/tasks/images');
    expect(taskPath('video')).toBe('/tasks/videos');
  });
});
