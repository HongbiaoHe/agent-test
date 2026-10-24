/**
 * createMediaTools 单元测试。
 * - list_media_models 透传目录
 * - generate_* 以正确类型/参数调 createAgentGenerations，返回 queued + generations
 * - 校验不通过 → invalid_params + issues（不 throw，交回模型改参）
 * - prompt 超过 2000 字符被 zod schema 拒绝
 * - BusinessException → 返回 error JSON（不上抛）；普通 Error → 继续上抛
 */
import { HttpStatus } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { createMediaTools } from './media.tools';
import { MediaService } from './media.service';

describe('createMediaTools', () => {
  const ctx = { conversationId: 'conv-1', userId: 'user-1' };
  const okResult = {
    ok: true,
    config: {
      channel: 'google',
      model: 'nano-banana-pro',
      params: { aspect_ratio: '1:1', resolution: '1K' },
    },
    generations: [
      { generationId: 'gen-1', versionId: 'ver-1' },
      { generationId: 'gen-2', versionId: 'ver-2' },
    ],
  };

  function buildSvc(
    createAgentGenerations: jest.Mock,
    createVoiceClone: jest.Mock = jest.fn(),
  ) {
    const svc = {
      createAgentGenerations,
      createVoiceClone,
      agentModelCatalog: jest
        .fn()
        .mockResolvedValue({ type: 'image', note: 'n', models: [] }),
    };
    // cast-at-injection：其余代码照常拿到 MediaService 类型（CLAUDE.md §8）
    return svc as unknown as MediaService & typeof svc;
  }

  function tools(svc: MediaService) {
    const [list, image, video, audio, clone] = createMediaTools(svc, ctx);
    return { list, image, video, audio, clone };
  }

  it('list_media_models 透传 agentModelCatalog(type, userId)', async () => {
    const svc = buildSvc(jest.fn());
    const out = await tools(svc).list.invoke({ type: 'image' });
    expect(JSON.parse(out)).toEqual({ type: 'image', note: 'n', models: [] });
    expect(svc.agentModelCatalog).toHaveBeenCalledWith('image', 'user-1');
  });

  it('generate_audio：类型为 audio，透传音频档位与参考音色', async () => {
    const svc = buildSvc(jest.fn().mockResolvedValue(okResult));
    await tools(svc).audio.invoke({
      prompt: '欢迎收听',
      model: 'seed-audio-1.0',
      params: { speech_rate: '-13', format: 'mp3' },
      referenceVersionIds: ['voice-ver'],
    });
    expect(svc.createAgentGenerations).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'audio',
      {
        prompt: '欢迎收听',
        model: 'seed-audio-1.0',
        params: { speech_rate: '-13', format: 'mp3' },
        referenceVersionIds: ['voice-ver'],
        count: 1,
      },
    );
  });

  it('clone_voice：透传源录音/语言/文案，返回 queued + 单个 generation', async () => {
    const createVoiceClone = jest.fn().mockResolvedValue({
      ok: true,
      config: {
        channel: 'byteplus',
        model: 'voice-replication-2.0',
        params: { language: '0' },
      },
      generation: { generationId: 'gen-v', versionId: 'ver-v' },
    });
    const svc = buildSvc(jest.fn(), createVoiceClone);
    const parsed = JSON.parse(
      await tools(svc).clone.invoke({
        sourceVersionId: 'upload-1',
        language: '0',
        demoText: '今天天气真不错',
      }),
    );
    expect(createVoiceClone).toHaveBeenCalledWith('conv-1', 'user-1', {
      sourceVersionId: 'upload-1',
      language: '0',
      demoText: '今天天气真不错',
    });
    expect(parsed.status).toBe('queued');
    expect(parsed.generations).toEqual([
      { generationId: 'gen-v', versionId: 'ver-v' },
    ]);
    expect(parsed.next).toContain('seed-audio-1.0');
  });

  it('clone_voice 校验不通过 → invalid_params + issues', async () => {
    const issues = [{ field: 'demoText', message: 'demo 文案至少 4 个字符' }];
    const svc = buildSvc(
      jest.fn(),
      jest.fn().mockResolvedValue({ ok: false, issues }),
    );
    const parsed = JSON.parse(
      await tools(svc).clone.invoke({
        sourceVersionId: 'upload-1',
        language: '0',
        demoText: '你好',
      }),
    );
    expect(parsed.error).toBe('invalid_params');
    expect(parsed.issues).toEqual(issues);
  });

  it('generate_image：透传模型/参数/数量，返回 queued + generations', async () => {
    const svc = buildSvc(jest.fn().mockResolvedValue(okResult));
    const out = await tools(svc).image.invoke({
      prompt: '一只猫',
      model: 'nano-banana-pro',
      params: { aspect_ratio: '1:1' },
      referenceVersionIds: ['ref-1'],
      count: 2,
    });

    expect(JSON.parse(out)).toEqual({
      status: 'queued',
      model: 'nano-banana-pro',
      channel: 'google',
      params: { aspect_ratio: '1:1', resolution: '1K' },
      generations: okResult.generations,
    });
    expect(svc.createAgentGenerations).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'image',
      {
        prompt: '一只猫',
        model: 'nano-banana-pro',
        params: { aspect_ratio: '1:1' },
        referenceVersionIds: ['ref-1'],
        count: 2,
      },
    );
  });

  it('generate_video：count 缺省为 1，类型为 video', async () => {
    const svc = buildSvc(jest.fn().mockResolvedValue(okResult));
    await tools(svc).video.invoke({ prompt: '海浪' });
    expect(svc.createAgentGenerations).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'video',
      { prompt: '海浪', count: 1 },
    );
  });

  it('校验不通过 → invalid_params + issues（不 throw）', async () => {
    const issues = [
      {
        field: 'params.duration',
        value: '4',
        message: 'resolution=1080p/4k时 veo-3.1 的 duration 只能取 8',
        allowed: ['8'],
      },
    ];
    const svc = buildSvc(jest.fn().mockResolvedValue({ ok: false, issues }));
    const out = await tools(svc).video.invoke({
      prompt: 'p',
      model: 'veo-3.1',
      params: { resolution: '1080p', duration: '4' },
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('invalid_params');
    expect(parsed.issues).toEqual(issues);
    expect(parsed.hint).toContain('list_media_models');
  });

  it('prompt 超过 2000 字符被 schema 拒绝（不调服务）', async () => {
    const svc = buildSvc(jest.fn());
    await expect(
      tools(svc).image.invoke({ prompt: 'x'.repeat(2001) }),
    ).rejects.toThrow();
    expect(svc.createAgentGenerations).not.toHaveBeenCalled();
  });

  it('BusinessException（参考图非法）→ 返回 error + hint JSON（不 throw）', async () => {
    const svc = buildSvc(
      jest
        .fn()
        .mockRejectedValue(
          new BusinessException(
            ErrorCodes.MEDIA_REF_INVALID,
            HttpStatus.BAD_REQUEST,
          ),
        ),
    );
    const parsed = JSON.parse(
      await tools(svc).image.invoke({ prompt: '测试' }),
    );
    expect(parsed).toHaveProperty('error');
    expect(parsed.hint).toContain('versionId');
  });

  it('普通 Error 仍 throw', async () => {
    const svc = buildSvc(
      jest.fn().mockRejectedValue(new Error('db connection failed')),
    );
    await expect(tools(svc).video.invoke({ prompt: '测试' })).rejects.toThrow(
      'db connection failed',
    );
  });
});
