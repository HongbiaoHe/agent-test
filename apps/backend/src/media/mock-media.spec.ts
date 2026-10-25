import {
  MOCK_DELAY_MS,
  mockDelayMs,
  mockDuration,
  mockMediaEnabled,
  mockSize,
  mockSvg,
} from './mock-media';

describe('mockMediaEnabled', () => {
  const saved = {
    flag: process.env.CANVAS_MOCK_MEDIA_ENABLED,
    env: process.env.NODE_ENV,
  };
  afterEach(() => {
    process.env.CANVAS_MOCK_MEDIA_ENABLED = saved.flag;
    process.env.NODE_ENV = saved.env;
  });

  it('没配：生产关、其余环境开', () => {
    delete process.env.CANVAS_MOCK_MEDIA_ENABLED;
    process.env.NODE_ENV = 'production';
    expect(mockMediaEnabled()).toBe(false);
    process.env.NODE_ENV = 'development';
    expect(mockMediaEnabled()).toBe(true);
  });

  it('显式配置覆盖环境默认', () => {
    process.env.NODE_ENV = 'production';
    process.env.CANVAS_MOCK_MEDIA_ENABLED = 'true';
    expect(mockMediaEnabled()).toBe(true);
    process.env.NODE_ENV = 'development';
    process.env.CANVAS_MOCK_MEDIA_ENABLED = '0';
    expect(mockMediaEnabled()).toBe(false);
  });
});

describe('mockDelayMs', () => {
  it('落在按类型的区间里：图 5–10 秒、视频 10–20 秒', () => {
    expect(MOCK_DELAY_MS).toEqual({
      image: [5_000, 10_000],
      video: [10_000, 20_000],
    });
    expect(mockDelayMs('image', () => 0)).toBe(5_000);
    expect(mockDelayMs('image', () => 1)).toBe(10_000);
    expect(mockDelayMs('video', () => 0.5)).toBe(15_000);
  });
});

describe('mockSize', () => {
  it('画幅严格按参数，长边图 1024 / 视频 720', () => {
    expect(mockSize('video', '9:16')).toEqual({ width: 406, height: 720 });
    expect(mockSize('video', '16:9')).toEqual({ width: 720, height: 406 });
    expect(mockSize('image', '1:1')).toEqual({ width: 1024, height: 1024 });
    expect(mockSize('image', '16x9')).toEqual({ width: 1024, height: 576 });
  });

  it('adaptive / 没设 / 认不出 → 按 16:9', () => {
    for (const ar of ['adaptive', undefined, 'wide']) {
      expect(mockSize('video', ar)).toEqual({ width: 720, height: 406 });
    }
  });

  it('宽高恒为偶数（yuv420p 要求）', () => {
    const { width, height } = mockSize('video', '21:9');
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});

describe('mockDuration', () => {
  it('取档位 duration；没有或非正数（-1 自动）按 5 秒', () => {
    expect(mockDuration({ duration: '8' })).toBe(8);
    expect(mockDuration({})).toBe(5);
    expect(mockDuration({ duration: '-1' })).toBe(5);
  });
});

describe('mockSvg', () => {
  it('文字做 XML 转义，标题与信息行都在画面里', () => {
    const svg = mockSvg(
      { title: '镜头1 <主视觉>', lines: ['seedance-2 · 9:16', 'refs: a & b'] },
      { width: 406, height: 720 },
    );
    expect(svg).toContain('镜头1 &#60;主视觉&#62;');
    expect(svg).toContain('refs: a &#38; b');
    expect(svg).toContain('MOCK');
    expect(svg).toContain('width="406" height="720"');
  });
});
