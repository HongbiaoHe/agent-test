import {
  formatAttachmentAnalysis,
  isSettled,
  type AnalysisRow,
} from './attachment-analysis';

const row = (versionId: string, extra: Partial<AnalysisRow>): AnalysisRow => ({
  versionId,
  status: 'done',
  summary: null,
  detail: null,
  error: null,
  ...extra,
});

describe('formatAttachmentAnalysis', () => {
  const attachments = [
    { versionId: 'v-img', type: 'image', filename: 'shoe.png' },
    { versionId: 'v-vid', type: 'video', filename: 'ref.mp4' },
    { versionId: 'v-aud', type: 'audio', filename: 'bgm.mp3' },
    { versionId: 'v-bad', type: 'image', filename: 'broken.png' },
  ];

  it('按附件顺序逐条列出，与 versionId 一一对应；要点按类型挑', () => {
    const text = formatAttachmentAnalysis(attachments, [
      row('v-img', {
        summary: '白色跑鞋棚拍产品图',
        detail: {
          subject: '白色网面跑鞋',
          composition: '3/4 侧视居中',
          style: '棚拍',
          orientation: '横版',
          text_in_image: '无',
        },
      }),
      row('v-vid', {
        summary: '城市夜跑',
        detail: {
          duration_seconds: 12.4,
          shots: [{}, {}, {}],
          style: '电影感',
          audio: '电子乐',
        },
      }),
      // v-aud 还没完成（pending）
      row('v-aud', { status: 'pending' }),
      row('v-bad', { status: 'failed', error: '下载素材失败：HTTP 404' }),
    ]);

    expect(text.split('\n')[0]).toContain('本轮 4 个附件');
    expect(text).toContain(
      '- image versionId=v-img 文件名 shoe.png\n  摘要：白色跑鞋棚拍产品图\n  要点：主体：白色网面跑鞋；构图：3/4 侧视居中；风格：棚拍；画幅：横版',
    );
    // 画面文字为「无」时不进要点
    expect(text).not.toContain('画面文字');
    expect(text).toContain(
      '时长：约 12 秒；分镜：3 个；风格：电影感；音频：电子乐',
    );
    expect(text).toContain('- audio versionId=v-aud 文件名 bgm.mp3\n  分析中');
    // 失败要明说别再调工具：重调只会白等
    expect(text).toContain(
      '未能分析（下载素材失败：HTTP 404）：不要再调 get_media_analysis',
    );
    // 顺序与附件一致
    expect(text.indexOf('v-img')).toBeLessThan(text.indexOf('v-vid'));
    expect(text.indexOf('v-aud')).toBeLessThan(text.indexOf('v-bad'));
  });

  it('没有分析行的附件也标「分析中」，跳过的标「未分析」', () => {
    const text = formatAttachmentAnalysis(
      [
        { versionId: 'v1', type: 'image', filename: 'a.png' },
        { versionId: 'v2', type: 'image', filename: 'b.png' },
      ],
      [row('v2', { status: 'skipped' })],
    );
    expect(text).toContain('v1 文件名 a.png\n  分析中');
    expect(text).toContain('v2 文件名 b.png\n  未分析');
  });

  it('多行的画面文字压成一行，不拆断要点行', () => {
    const text = formatAttachmentAnalysis(
      [{ versionId: 'v1', type: 'image', filename: 'a.png' }],
      [
        row('v1', {
          summary: '促销海报',
          detail: { text_in_image: 'RUN FAST\nSALE 50% OFF' },
        }),
      ],
    );
    expect(text).toContain('要点：画面文字：RUN FAST SALE 50% OFF');
  });

  it('isSettled：done / failed / skipped 是终态，pending 不是', () => {
    expect(['done', 'failed', 'skipped'].every(isSettled)).toBe(true);
    expect(isSettled('pending')).toBe(false);
  });
});
