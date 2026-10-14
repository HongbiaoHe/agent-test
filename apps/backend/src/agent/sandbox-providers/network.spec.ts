import {
  ALLOW_ENTRY_RE,
  egressSignature,
  isIpOrCidr,
  normalizeAllowList,
  type SandboxNetwork,
  toDaytonaEgress,
  toE2bEgress,
} from './network';

const net = (over: Partial<SandboxNetwork>): SandboxNetwork => ({
  egress: 'open',
  allowList: [],
  publicTraffic: false,
  ...over,
});

describe('ALLOW_ENTRY_RE / isIpOrCidr', () => {
  it.each([
    'pypi.org',
    '*.github.com',
    'files.pythonhosted.org',
    '1.1.1.1',
    '10.0.0.0/8',
    '0.0.0.0/0',
  ])('合法：%s', (e) => expect(ALLOW_ENTRY_RE.test(e)).toBe(true));

  it.each([
    '*',
    'http://pypi.org',
    'pypi',
    '256.1.1.1',
    '1.1.1.1/33',
    'a b.com',
    '*.',
  ])('非法：%s', (e) => expect(ALLOW_ENTRY_RE.test(e)).toBe(false));

  it('isIpOrCidr 只认 IP / CIDR', () => {
    expect(isIpOrCidr('1.2.3.4')).toBe(true);
    expect(isIpOrCidr('1.2.3.0/24')).toBe(true);
    expect(isIpOrCidr('pypi.org')).toBe(false);
  });
});

describe('normalizeAllowList', () => {
  it('去空白、小写、去重、保序', () => {
    expect(
      normalizeAllowList([' PyPI.org ', 'pypi.org', '', '1.1.1.1']),
    ).toEqual(['pypi.org', '1.1.1.1']);
  });
});

describe('toE2bEgress', () => {
  it('open → 不设规则；blocked → 全拒', () => {
    expect(toE2bEgress(net({}))).toEqual({});
    expect(toE2bEgress(net({ egress: 'blocked' }))).toEqual({
      denyOut: ['0.0.0.0/0'],
    });
  });
  it('allowlist → 全拒 + 放行白名单；空白名单 = 全拒', () => {
    expect(
      toE2bEgress(net({ egress: 'allowlist', allowList: ['pypi.org'] })),
    ).toEqual({
      allowOut: ['pypi.org'],
      denyOut: ['0.0.0.0/0'],
    });
    expect(toE2bEgress(net({ egress: 'allowlist' }))).toEqual({
      denyOut: ['0.0.0.0/0'],
    });
  });
});

describe('toDaytonaEgress', () => {
  it('open / blocked', () => {
    expect(toDaytonaEgress(net({}))).toEqual({ networkBlockAll: false });
    expect(toDaytonaEgress(net({ egress: 'blocked' }))).toEqual({
      networkBlockAll: true,
    });
  });
  it('allowlist 只取 IP/CIDR，单 IP 补 /32，域名忽略', () => {
    expect(
      toDaytonaEgress(
        net({
          egress: 'allowlist',
          allowList: ['pypi.org', '1.1.1.1', '10.0.0.0/8'],
        }),
      ),
    ).toEqual({
      networkBlockAll: false,
      networkAllowList: '1.1.1.1/32,10.0.0.0/8',
    });
  });
  it('白名单只有域名 → 按全禁止（不能因过滤掉域名而变成全放行）', () => {
    expect(
      toDaytonaEgress(net({ egress: 'allowlist', allowList: ['pypi.org'] })),
    ).toEqual({
      networkBlockAll: true,
    });
  });
});

describe('egressSignature', () => {
  it('口径：open / blocked / allow:排序列表', () => {
    expect(egressSignature({ blockAll: false, allow: ['x'] })).toBe('open');
    expect(egressSignature({ blockAll: true, allow: [] })).toBe('blocked');
    expect(egressSignature({ blockAll: true, allow: ['b.com', 'a.com'] })).toBe(
      'allow:a.com,b.com',
    );
  });
});
