import { Readable } from 'node:stream';
import type { Request } from 'express';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { desktopScope, MediaApiController } from './media-api.controller';
import type { MediaUploadService } from './media-upload.service';
import type { MediaService } from './media.service';

describe('MediaApiController（桌面端媒体接口）', () => {
  const user: AuthUser = { userId: 'u1', tenantId: 't1', email: 'a@b.c' };
  const media = {
    agentModelCatalog: jest.fn().mockResolvedValue({ models: [] }),
    createAgentGenerations: jest
      .fn()
      .mockResolvedValue({ ok: false, issues: [] }),
    createVoiceClone: jest.fn().mockResolvedValue({ ok: false, issues: [] }),
    listForConversation: jest.fn().mockResolvedValue([]),
    resolveSandboxSources: jest
      .fn()
      .mockResolvedValue({ sources: [], errors: [] }),
  };
  const uploads = { store: jest.fn().mockResolvedValue({ versionId: 'v1' }) };
  const ctl = new MediaApiController(
    media as unknown as MediaService,
    uploads as unknown as MediaUploadService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('桌面会话按 desktop: 前缀记账，与 Spark / 画布会话 id 不冲突', () => {
    expect(desktopScope('abc-123')).toBe('desktop:abc-123');
  });

  it('生成 / 克隆 / 列表都转调同一个 MediaService，归属按当前用户', async () => {
    await ctl.generate(
      { scope: 's1', type: 'image', prompt: 'cat', count: 2, model: 'm' },
      user,
    );
    expect(media.createAgentGenerations).toHaveBeenCalledWith(
      'desktop:s1',
      'u1',
      'image',
      expect.objectContaining({ prompt: 'cat', count: 2, model: 'm' }),
    );
    await ctl.cloneVoice(
      {
        scope: 's1',
        sourceVersionId: 'v9',
        language: '0',
        demoText: '你好世界',
      },
      user,
    );
    expect(media.createVoiceClone).toHaveBeenCalledWith('desktop:s1', 'u1', {
      sourceVersionId: 'v9',
      language: '0',
      demoText: '你好世界',
    });
    await ctl.list({ scope: 's1' }, user);
    expect(media.listForConversation).toHaveBeenCalledWith('desktop:s1', 'u1');
    await ctl.sources({ scope: 's1', versionIds: ['v1', 'v1', 'v2'] }, user);
    expect(media.resolveSandboxSources).toHaveBeenCalledWith(
      'desktop:s1',
      'u1',
      ['v1', 'v2'],
    );
    await ctl.models({ type: 'audio' }, user);
    expect(media.agentModelCatalog).toHaveBeenCalledWith('audio', 'u1');
  });

  it('上传直接落 done（传完即可被引用），文件名清洗、MIME 去参数', async () => {
    const req = Readable.from([Buffer.from('x')]) as unknown as Request;
    await ctl.upload(
      { scope: 's1' },
      'image/png; charset=binary',
      '1',
      '../../evil/cat.png',
      req,
      user,
    );
    expect(uploads.store).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'desktop:s1',
        userId: 'u1',
        contentType: 'image/png',
        size: 1,
        filename: 'cat.png',
        status: 'done',
      }),
    );
  });
});
