/**
 * 把 WebAuthn 注册返回的 aaguid（认证器厂商标识）解析成展示用来源名。
 * 命中内置常见厂商表则返回品牌名；未命中按 deviceType 兜底（云同步 / 单设备）。
 * 仅收录常见的几家，YAGNI：不引入完整 AAGUID 数据集。
 */
const AAGUID_NAMES: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 钥匙串',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a5': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
};

const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000';

export function resolveProviderName(
  aaguid: string | null,
  deviceType: string | null,
): string {
  if (aaguid && aaguid !== ZERO_AAGUID) {
    const name = AAGUID_NAMES[aaguid.toLowerCase()];
    if (name) return name;
  }
  if (deviceType === 'multiDevice') return '云同步 passkey';
  if (deviceType === 'singleDevice') return '设备 passkey';
  return 'Passkey';
}
