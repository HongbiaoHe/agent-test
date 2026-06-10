/**
 * createMediaTools 单元测试。
 * - 工具调用返回含 generationId/versionId 的 queued JSON
 * - prompt 超过 2000 字符被 zod schema 拒绝
 */
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

    expect(JSON.parse(out as string)).toEqual({
      generationId: 'gen-1',
      versionId: 'ver-1',
      status: 'queued',
    });
    expect(svc.createGeneration).toHaveBeenCalledWith('conv-1', 'user-1', 'image', '一只猫', undefined);
  });

  it('generate_video 以 video 类型调 createGeneration', async () => {
    const svc = buildSvc();
    const [, videoTool] = createMediaTools(svc, ctx);

    await videoTool.invoke({ prompt: '海浪' });

    expect(svc.createGeneration).toHaveBeenCalledWith('conv-1', 'user-1', 'video', '海浪', undefined);
  });

  it('prompt 超过 2000 字符被 schema 拒绝（不调 createGeneration）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await expect(imageTool.invoke({ prompt: 'x'.repeat(2001) })).rejects.toThrow();
    expect(svc.createGeneration).not.toHaveBeenCalled();
  });

  it('referenceVersionIds 透传给 createGeneration（图生图多张）', async () => {
    const svc = buildSvc();
    const [imageTool] = createMediaTools(svc, ctx);

    await imageTool.invoke({ prompt: '改图', referenceVersionIds: ['ref-1', 'ref-2'] });

    expect(svc.createGeneration).toHaveBeenCalledWith('conv-1', 'user-1', 'image', '改图', [
      'ref-1',
      'ref-2',
    ]);
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

    expect(svc.createGeneration).toHaveBeenCalledWith('conv-1', 'user-1', 'image', '一只猫', undefined);
  });
});
