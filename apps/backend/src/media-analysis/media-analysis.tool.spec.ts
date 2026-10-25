import type { MediaAnalysisService } from './media-analysis.service';
import { createMediaAnalysisTool } from './media-analysis.tool';

describe('get_media_analysis', () => {
  const getForUser = jest.fn();
  // cast-at-injection：只用到 getForUser
  const tool = createMediaAnalysisTool(
    { getForUser } as unknown as MediaAnalysisService,
    { userId: 'u1' },
  );
  const call = async (versionId: string) =>
    JSON.parse(String(await tool.invoke({ versionId }))) as Record<
      string,
      unknown
    >;

  afterEach(() => jest.clearAllMocks());

  it('分析完成：返回结构化细节', async () => {
    getForUser.mockResolvedValue({
      versionId: 'v1',
      type: 'image',
      row: { versionId: 'v1', status: 'done', detail: { summary: '海报' } },
    });
    expect(await call('v1')).toEqual({
      versionId: 'v1',
      type: 'image',
      status: 'done',
      analysis: { summary: '海报' },
    });
  });

  it('分析失败：带上「不要再调」的提示，免得 agent 反复重试', async () => {
    getForUser.mockResolvedValue({
      versionId: 'v1',
      type: 'image',
      row: { versionId: 'v1', status: 'failed', error: '连不上分析服务' },
    });
    const r = await call('v1');
    expect(r).toMatchObject({ status: 'failed', error: '连不上分析服务' });
    expect(String(r.note)).toContain('不要再对这个素材调用本工具');
  });

  it('不属于当前用户：回错误', async () => {
    getForUser.mockResolvedValue({ error: '没有这个素材' });
    expect(await call('v9')).toEqual({ error: '没有这个素材' });
  });
});
