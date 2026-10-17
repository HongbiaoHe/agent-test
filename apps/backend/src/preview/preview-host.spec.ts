import {
  parsePreviewHost,
  previewOrigin,
  sharesSiteWithMain,
} from './preview-host';

describe('preview-host（子域名约定）', () => {
  const base = new URL('http://localhost:3101');
  const id = 'a'.repeat(32);

  it('签发的源能被解析回同一个 id（含端口）', () => {
    const origin = previewOrigin(id, base);
    expect(origin).toBe(`http://p-${id}.localhost:3101`);
    expect(parsePreviewHost(new URL(origin).host, base)).toBe(id);
  });

  it('大小写不敏感', () => {
    expect(parsePreviewHost(`P-${id.toUpperCase()}.LOCALHOST:3101`, base)).toBe(
      id,
    );
  });

  it('主站请求、其它基域名、端口不同、id 格式不对 → 都不是预览请求', () => {
    expect(parsePreviewHost('localhost:3101', base)).toBeNull();
    expect(parsePreviewHost(undefined, base)).toBeNull();
    expect(parsePreviewHost(`p-${id}.evil.com`, base)).toBeNull();
    expect(parsePreviewHost(`p-${id}.localhost:3100`, base)).toBeNull();
    expect(parsePreviewHost(`p-${id}.x.localhost:3101`, base)).toBeNull();
    expect(parsePreviewHost('p-nothex.localhost:3101', base)).toBeNull();
  });

  it('生产基域名（https + 无端口）', () => {
    const prod = new URL('https://preview.example.com');
    expect(previewOrigin(id, prod)).toBe(`https://p-${id}.preview.example.com`);
    expect(parsePreviewHost(`p-${id}.preview.example.com`, prod)).toBe(id);
  });
});

describe('sharesSiteWithMain（部署配置检查）', () => {
  const u = (s: string) => new URL(s);
  it('预览用主站的子域 → 同站（预览页能碰到主站父域 cookie，需告警）', () => {
    expect(
      sharesSiteWithMain(
        u('https://preview.example.com'),
        'https://app.example.com',
      ),
    ).toBe(true);
    expect(
      sharesSiteWithMain(u('https://p.example.com'), 'https://example.com'),
    ).toBe(true);
  });
  it('独立的可注册域名 → 不同站', () => {
    expect(
      sharesSiteWithMain(
        u('https://example-preview.app'),
        'https://app.example.com',
      ),
    ).toBe(false);
  });
  it('本地开发（localhost / IP）与未配置主站 → 不判', () => {
    expect(
      sharesSiteWithMain(u('http://localhost:3101'), 'http://localhost:3100'),
    ).toBe(false);
    expect(
      sharesSiteWithMain(u('http://127.0.0.1:3101'), 'http://127.0.0.1:3100'),
    ).toBe(false);
    expect(
      sharesSiteWithMain(u('https://preview.example.com'), undefined),
    ).toBe(false);
  });
});
