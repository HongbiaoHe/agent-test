import { isBlockedIp, safeFetch, SafeFetchError } from './safe-fetch';

const anyType = { maxBytesFor: () => 1024 };

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.4',
    '169.254.169.254', // 云元数据
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('拦截 %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '放行 %s',
    (ip) => expect(isBlockedIp(ip)).toBe(false),
  );
});

describe('safeFetch 拒绝', () => {
  it.each([
    ['http 地址', 'http://example.com/a.png', '只支持 https'],
    ['带账号密码', 'https://u:p@example.com/a.png', '账号密码'],
    ['字面内网 IP', 'https://10.0.0.1/a.png', '内网'],
    ['字面 IPv6 回环', 'https://[::1]/a.png', '内网'],
    ['解析到回环的域名', 'https://localhost/a.png', '内网'],
    ['非法 URL', 'not a url', 'URL 格式'],
  ])('%s', async (_name, url, msg) => {
    const p = safeFetch(url, anyType);
    await expect(p).rejects.toBeInstanceOf(SafeFetchError);
    await expect(p).rejects.toThrow(msg);
  });
});
