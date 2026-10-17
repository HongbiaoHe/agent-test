import { fileResponseHeaders, resolveSitePath } from './site-files';

describe('resolveSitePath', () => {
  it('站点根 + 路径；去掉 query / hash；逐段解码', () => {
    expect(resolveSitePath('site', '/app.js?v=1#x')).toBe('site/app.js');
    expect(resolveSitePath('site', '/img/%E5%9B%BE.png')).toBe(
      'site/img/图.png',
    );
    expect(resolveSitePath('', '/index.html')).toBe('index.html');
  });

  it('以 / 结尾补 index.html（含根 /）', () => {
    expect(resolveSitePath('site', '/')).toBe('site/index.html');
    expect(resolveSitePath('site', '/sub/')).toBe('site/sub/index.html');
  });

  it('.. / 编码的 .. / 反斜杠 / 非法编码 → null', () => {
    expect(resolveSitePath('site', '/../secret')).toBeNull();
    expect(resolveSitePath('site', '/a/%2e%2e/%2e%2e/secret')).toBeNull();
    expect(resolveSitePath('site', '/a%5c..%5csecret')).toBeNull();
    expect(resolveSitePath('site', '/%E0%A4%A')).toBeNull();
  });
});

describe('fileResponseHeaders', () => {
  it('文本类补 utf-8；二进制不加；no-referrer / nosniff / no-store；不带 CSP sandbox', () => {
    expect(fileResponseHeaders('a/index.html')['content-type']).toBe(
      'text/html; charset=utf-8',
    );
    expect(fileResponseHeaders('a/s.css')['content-type']).toBe(
      'text/css; charset=utf-8',
    );
    expect(fileResponseHeaders('a/logo.png')['content-type']).toBe('image/png');
    const h = fileResponseHeaders('index.html');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store');
    expect(h).not.toHaveProperty('content-security-policy');
  });
});
