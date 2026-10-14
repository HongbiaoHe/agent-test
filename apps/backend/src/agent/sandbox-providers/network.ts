/**
 * 沙箱网络设置（/settings/sandbox 的「网络」卡片）与各提供方参数的映射（纯函数，便于单测）。
 *
 * 能力差异（2026-10-14 查 SDK 类型 + 官方文档）：
 * - E2B：出站 allowOut/denyOut 支持域名（可 `*.` 通配）、IP、CIDR；同一地址两边都命中时 allow 优先；
 *   域名过滤只对 80 端口 HTTP（Host）与 443 端口 TLS（SNI）生效。Sandbox.updateNetwork 运行中整体替换。
 *   入站 allowPublicTraffic 只能创建时设置（默认公网地址任何人可访问）。
 * - Daytona：networkBlockAll / networkAllowList（逗号分隔 **CIDR**，不支持域名），
 *   sandbox.updateNetworkSettings 运行中生效。入站预览链接默认需鉴权（public 未设为 true）。
 */

export type SandboxEgressMode = 'open' | 'allowlist' | 'blocked';

export const SANDBOX_EGRESS_MODES: SandboxEgressMode[] = [
  'open',
  'allowlist',
  'blocked',
];

export interface SandboxNetwork {
  /** 出站：open 全放行 / allowlist 仅白名单 / blocked 全禁止 */
  egress: SandboxEgressMode;
  /** 白名单条目（域名 / IP / CIDR），仅 allowlist 生效 */
  allowList: string[];
  /** 端口公网地址是否免鉴权（仅 E2B 可配，创建时生效） */
  publicTraffic: boolean;
}

/** 默认：出站开放（agent 要 pip/npm install）、入站需鉴权（不暴露 agent 起的服务）。 */
export const DEFAULT_SANDBOX_NETWORK: SandboxNetwork = {
  egress: 'open',
  allowList: [],
  publicTraffic: false,
};

export const ALLOW_LIST_MAX = 50;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_CIDR_RE = new RegExp(
  `^${OCTET}(\\.${OCTET}){3}(\\/(3[0-2]|[12]?\\d))?$`,
);
const DOMAIN_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** 白名单条目整体校验（DTO @Matches 用）：IPv4 / IPv4 CIDR / 域名（可 `*.` 前缀）。 */
export const ALLOW_ENTRY_RE = new RegExp(
  `(${IPV4_CIDR_RE.source})|(${DOMAIN_RE.source})`,
  'i',
);

export function isIpOrCidr(entry: string): boolean {
  return IPV4_CIDR_RE.test(entry);
}

/** 归一：去空白、小写、去重，保持输入顺序。 */
export function normalizeAllowList(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

const ALL_TRAFFIC = '0.0.0.0/0';

/** E2B 出站参数（create 的 network 与 updateNetwork 共用；open = 不设任何规则）。 */
export function toE2bEgress(net: SandboxNetwork): {
  allowOut?: string[];
  denyOut?: string[];
} {
  if (net.egress === 'blocked') return { denyOut: [ALL_TRAFFIC] };
  if (net.egress === 'allowlist') {
    // 全拒 + 白名单放行（allow 优先）；空白名单即等同全禁止
    return net.allowList.length
      ? { allowOut: net.allowList, denyOut: [ALL_TRAFFIC] }
      : { denyOut: [ALL_TRAFFIC] };
  }
  return {};
}

/**
 * Daytona 出站参数。只支持 CIDR：域名条目被忽略（前端已提示）；
 * 白名单里没有任何 IP/CIDR 时按全禁止处理（不能因为过滤掉了域名就变成全放行）。
 */
export function toDaytonaEgress(net: SandboxNetwork): {
  networkBlockAll: boolean;
  networkAllowList?: string;
} {
  if (net.egress === 'blocked') return { networkBlockAll: true };
  if (net.egress === 'allowlist') {
    const cidrs = net.allowList
      .filter(isIpOrCidr)
      .map((e) => (e.includes('/') ? e : `${e}/32`));
    return cidrs.length
      ? { networkBlockAll: false, networkAllowList: cidrs.join(',') }
      : { networkBlockAll: true };
  }
  return { networkBlockAll: false };
}

/**
 * 出站策略指纹：比较「远端现状」与「用户设置」是否一致，一致就不发更新请求。
 * 各提供方把自己的远端字段换算成同一口径（见 toListing / daytona listUserSandboxes）。
 */
export function egressSignature(rules: {
  blockAll: boolean;
  allow: string[];
}): string {
  if (!rules.blockAll) return 'open';
  return rules.allow.length
    ? `allow:${[...rules.allow].sort().join(',')}`
    : 'blocked';
}

/**
 * 提供方拒绝在沙箱级别修改出站策略（如 Daytona Tier 1/2：组织级网络策略优先，API 直接报错；
 * 2026-10-14 实测该账户只放行 PyPI / npm / GitHub 等常用服务）。设置服务据此回滚并提示用户。
 */
export class SandboxNetworkUnsupportedError extends Error {
  // 用 name 而非 instanceof 判别：worker 等处的单测会把本模块整体 mock 掉
  override name = 'SandboxNetworkUnsupportedError';
}
