import type { AigcClient } from './aigc.client';
import { AigcService } from './aigc.service';
import { aigcModelSchema, type AigcChannel } from './aigc.types';

/**
 * prepareNodeConfig（画布 agent 的 set_node_model）：
 * - 模型名 / 档位取值 / 约束不合法 → issues，交回模型改参；
 * - 上游素材超出模型上限不拒，按提交时的规则截掉并报 dropped，derived 维度按截后的张数算。
 */
const veo = aigcModelSchema.parse({
  model_alias: 'veo-3.1',
  display_name: 'Veo 3.1',
  type: 'video',
  image_input_number: 3,
  params: [
    {
      param_type: 'aspect_ratio',
      input: 'required',
      options: ['16:9', '9:16'].map((v) => ({ label: v, value: v })),
    },
    {
      param_type: 'duration',
      input: 'required',
      options: ['4', '8'].map((v) => ({ label: `${v}s`, value: v })),
    },
  ],
  // 带参考图时只能 8 秒：用来检验 derived 维度按截后的张数算
  constraints: [
    { when: { input_has_image: ['yes'] }, allow: { duration: ['8'] } },
  ],
});

// 首帧模式（videoRefRole 名单内）：目录说收 2 张图，实际只提交第一张
const seedance15 = aigcModelSchema.parse({
  model_alias: 'seedance-1.5-pro',
  type: 'video',
  image_input_number: 2,
  params: [],
});

const CHANNELS: AigcChannel[] = [
  { channel: 'google', models: [veo] },
  { channel: 'byteplus', models: [seedance15] },
];

function service() {
  // cast-at-injection：只用到 listChannels
  return new AigcService({
    listChannels: () => Promise.resolve(CHANNELS),
  } as unknown as AigcClient);
}

const counts = (image: number, video = 0, audio = 0) => ({
  image,
  video,
  audio,
});

describe('AigcService.prepareNodeConfig', () => {
  it('合法：认展示名，回最终档位，没有素材被丢', async () => {
    const r = await service().prepareNodeConfig('video', {
      model: 'Veo 3.1',
      params: { aspect_ratio: '16:9' },
      referenceCounts: counts(0),
    });
    expect(r).toEqual({
      ok: true,
      config: {
        channel: 'google',
        model: 'veo-3.1',
        params: { aspect_ratio: '16:9', duration: '4' },
      },
      dropped: counts(0),
    });
  });

  it('不存在的模型 → issue 带可选模型名', async () => {
    const r = await service().prepareNodeConfig('video', {
      model: 'sora-9',
      referenceCounts: counts(0),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({
      field: 'model',
      allowed: ['veo-3.1', 'seedance-1.5-pro'],
    });
  });

  it('档位取值不在目录里 → issue 带 allowed', async () => {
    const r = await service().prepareNodeConfig('video', {
      model: 'veo-3.1',
      params: { aspect_ratio: '4:3' },
      referenceCounts: counts(0),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({
      field: 'params.aspect_ratio',
      allowed: ['16:9', '9:16'],
    });
  });

  it('有参考图时违反约束 → issue；没有参考图则放行', async () => {
    const withImage = await service().prepareNodeConfig('video', {
      model: 'veo-3.1',
      params: { duration: '4' },
      referenceCounts: counts(1),
    });
    expect(withImage.ok).toBe(false);

    const noImage = await service().prepareNodeConfig('video', {
      model: 'veo-3.1',
      params: { duration: '4' },
      referenceCounts: counts(0),
    });
    expect(noImage.ok).toBe(true);
  });

  it('超出模型上限的素材不拒，按提交规则截掉并报 dropped', async () => {
    const r = await service().prepareNodeConfig('video', {
      model: 'veo-3.1',
      referenceCounts: counts(5, 2, 1),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // veo 收 3 张图、不收视频 / 音频
    expect(r.dropped).toEqual(counts(2, 2, 1));
  });

  it('首帧模式只算第一张图', async () => {
    const r = await service().prepareNodeConfig('video', {
      model: 'seedance-1.5-pro',
      referenceCounts: counts(3),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toEqual(counts(2));
  });
});
