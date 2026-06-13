/**
 * createMediaTools 单元测试。
 * - 工具调用返回含 generationId/versionId 的 queued JSON
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

  function buildSvc() {
    return {
      createGeneration: jest
        .fn()
        .mockResolvedValue({ generationId: 'gen-1', versionId: 'ver-1' }),
    } as unknown as MediaService;
  }

  it('generate_image 返回 queued JSON 含 ids，并以 image 类型调 createGeneration', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    const out = await imageTool.invoke({ prompt: '一只猫' });

    expect(JSON.parse(out)).toEqual({
      generationId: 'gen-1',
      versionId: 'ver-1',
      status: 'queued',
    });
    expect(svc.createGeneration).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'image',
      '一只猫',
      undefined,
    );
  });

  it('generate_video 以 video 类型调 createGeneration', async () => {
    const svc = buildSvc();
    const [, videoTool] = createMediaTools(svc, ctx);

    await videoTool.invoke({ prompt: '海浪' });

    expect(svc.createGeneration).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'video',
      '海浪',
      undefined,
    );
  });

  it('prompt 超过 2000 字符被 schema 拒绝（不调 createGeneration）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await expect(
      imageTool.invoke({ prompt: 'x'.repeat(2001) }),
    ).rejects.toThrow();
    expect(svc.createGeneration).not.toHaveBeenCalled();
  });

  it('referenceVersionIds 透传给 createGeneration（图生图多张）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await imageTool.invoke({
      prompt: '改图',
      referenceVersionIds: ['ref-1', 'ref-2'],
    });

    expect(svc.createGeneration).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'image',
      '改图',
      ['ref-1', 'ref-2'],
    );
  });

  it('referenceVersionIds 超过 4 张被 schema 拒绝（不调 createGeneration）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await expect(
      imageTool.invoke({
        prompt: 'p',
        referenceVersionIds: ['1', '2', '3', '4', '5'],
      }),
    ).rejects.toThrow();
    expect(svc.createGeneration).not.toHaveBeenCalled();
  });

  it('referenceVersionIds 可选（不传时正常调用，第 5 参为 undefined）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await imageTool.invoke({ prompt: '一只猫' });

    expect(svc.createGeneration).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      'image',
      '一只猫',
      undefined,
    );
  });

  it('generate_image：createGeneration 抛 BusinessException 时工具返回含 error 的 JSON（不 throw）', async () => {
    const svc = {
      createGeneration: jest
        .fn()
        .mockRejectedValue(
          new BusinessException(
            ErrorCodes.MEDIA_REF_INVALID,
            HttpStatus.BAD_REQUEST,
          ),
        ),
    } as unknown as MediaService;
    const [imageTool] = createMediaTools(svc, ctx);

    // 不应 throw，应返回 JSON 字符串
    const out = await imageTool.invoke({ prompt: '测试' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('hint');
    expect(parsed.hint).toContain('versionId');
  });

  it('generate_image：createGeneration 抛普通 Error 时仍 throw', async () => {
    const svc = {
      createGeneration: jest
        .fn()
        .mockRejectedValue(new Error('db connection failed')),
    } as unknown as MediaService;
    const [imageTool] = createMediaTools(svc, ctx);

    await expect(imageTool.invoke({ prompt: '测试' })).rejects.toThrow(
      'db connection failed',
    );
  });

  it('generate_video：createGeneration 抛 BusinessException 时工具返回含 error 的 JSON（不 throw）', async () => {
    const svc = {
      createGeneration: jest
        .fn()
        .mockRejectedValue(
          new BusinessException(
            ErrorCodes.MEDIA_REF_INVALID,
            HttpStatus.BAD_REQUEST,
          ),
        ),
    } as unknown as MediaService;
    const [, videoTool] = createMediaTools(svc, ctx);

    const out = await videoTool.invoke({ prompt: '测试视频' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('hint');
  });
});
