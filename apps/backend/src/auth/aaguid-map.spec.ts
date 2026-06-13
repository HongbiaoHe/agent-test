import { resolveProviderName } from './aaguid-map';

describe('resolveProviderName', () => {
  it('已知 aaguid 命中厂商名（iCloud 钥匙串）', () => {
    expect(
      resolveProviderName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd', 'multiDevice'),
    ).toBe('iCloud 钥匙串');
  });

  it('已知 aaguid 命中厂商名（Google 密码管理器）', () => {
    expect(
      resolveProviderName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'multiDevice'),
    ).toBe('Google 密码管理器');
  });

  it('未知 aaguid + multiDevice → 云同步兜底', () => {
    expect(resolveProviderName('11111111-2222-3333-4444-555555555555', 'multiDevice')).toBe(
      '云同步 passkey',
    );
  });

  it('未知 aaguid + singleDevice → 设备兜底', () => {
    expect(resolveProviderName('11111111-2222-3333-4444-555555555555', 'singleDevice')).toBe(
      '设备 passkey',
    );
  });

  it('全零 aaguid（认证器未透露）按 deviceType 兜底', () => {
    expect(resolveProviderName('00000000-0000-0000-0000-000000000000', 'multiDevice')).toBe(
      '云同步 passkey',
    );
  });

  it('aaguid/deviceType 均缺失 → 通用兜底', () => {
    expect(resolveProviderName(null, null)).toBe('Passkey');
  });
});
