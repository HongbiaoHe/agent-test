import {
  downstreamResponseHeaders,
  upgradeRequestHeaders,
  upstreamRequestHeaders,
} from './proxy-headers';

const access = { 'x-daytona-preview-token': 'SECRET' };

describe('upstreamRequestHeaders', () => {
  it('去掉逐跳头与 Host，注入访问头；浏览器伪造的同名访问头（大小写不同也算）被丢弃', () => {
    const out = upstreamRequestHeaders(
      {
        host: 'p-x.localhost:3101',
        connection: 'keep-alive',
        'accept-encoding': 'gzip',
        cookie: 'a=1',
        'X-Daytona-Preview-Token': 'forged',
      },
      access,
    );
    expect(out).toEqual({
      'accept-encoding': 'gzip',
      cookie: 'a=1',
      'x-daytona-preview-token': 'SECRET',
    });
  });

  it('多值头拼接', () => {
    expect(upstreamRequestHeaders({ 'x-multi': ['a', 'b'] }, {})).toEqual({
      'x-multi': 'a, b',
    });
  });
});

describe('upgradeRequestHeaders', () => {
  it('保留 WebSocket 握手头，Host 换成上游，访问头不可被浏览器覆盖', () => {
    const out = upgradeRequestHeaders(
      {
        host: 'p-x.localhost:3101',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'k',
        'sec-websocket-protocol': 'vite-hmr',
        'x-daytona-preview-token': 'forged',
      },
      '5173-sb.proxy.daytona.works',
      access,
    );
    expect(out).toEqual([
      ['Host', '5173-sb.proxy.daytona.works'],
      ['upgrade', 'websocket'],
      ['connection', 'Upgrade'],
      ['sec-websocket-key', 'k'],
      ['sec-websocket-protocol', 'vite-hmr'],
      ['x-daytona-preview-token', 'SECRET'],
    ]);
  });
});

describe('downstreamResponseHeaders', () => {
  const origin = 'https://5173-sb.proxy.daytona.works';

  it('指回上游的重定向改成相对路径（否则浏览器被带去缺令牌的提供方域名）', () => {
    expect(
      downstreamResponseHeaders({ location: `${origin}/login?x=1` }, origin)
        .location,
    ).toBe('/login?x=1');
    expect(
      downstreamResponseHeaders({ location: 'https://other.com/' }, origin)
        .location,
    ).toBe('https://other.com/');
  });

  it('Set-Cookie 去掉 Domain，落到预览主机自己身上', () => {
    expect(
      downstreamResponseHeaders(
        { 'set-cookie': ['s=1; Domain=.daytona.works; Path=/', 't=2'] },
        origin,
      )['set-cookie'],
    ).toEqual(['s=1; Path=/', 't=2']);
  });

  it('正文原样透传：保留 content-encoding/length，丢逐跳头；强制 no-referrer', () => {
    const out = downstreamResponseHeaders(
      {
        'content-encoding': 'gzip',
        'content-length': '10',
        'transfer-encoding': 'chunked',
        connection: 'keep-alive',
        'referrer-policy': 'unsafe-url',
      },
      origin,
    );
    expect(out).toEqual({
      'content-encoding': 'gzip',
      'content-length': '10',
      'referrer-policy': 'no-referrer',
    });
  });
});
