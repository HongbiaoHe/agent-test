/**
 * 沙箱提供方选择。生效顺序：显式传入（用户在 /settings/profile 的偏好，见
 * SandboxSettingsService）> env SANDBOX_PROVIDER > daytona（保持历史行为）。
 * 每次调用即时读取环境变量（便宜，且单测可切换）。env 非法值直接抛错，避免静默用错提供方。
 */

import { daytonaProvider } from './daytona.provider';
import { e2bProvider } from './e2b.provider';
import type { SandboxProvider, SandboxProviderName } from './types';

const PROVIDERS: Record<SandboxProviderName, SandboxProvider> = {
  daytona: daytonaProvider,
  e2b: e2bProvider,
};

export function isSandboxProviderName(v: string): v is SandboxProviderName {
  return Object.hasOwn(PROVIDERS, v);
}

/** env SANDBOX_PROVIDER 指定的默认提供方（未配置 → daytona）。 */
export function defaultSandboxProviderName(): SandboxProviderName {
  const raw = (process.env.SANDBOX_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '') return 'daytona';
  if (!isSandboxProviderName(raw)) {
    throw new Error(
      `SANDBOX_PROVIDER 配置非法：${raw}（可选 ${Object.keys(PROVIDERS).join(' | ')}）`,
    );
  }
  return raw;
}

/** 取提供方：显式传入优先，否则用 env 默认。 */
export function getSandboxProvider(
  name?: SandboxProviderName,
): SandboxProvider {
  return PROVIDERS[name ?? defaultSandboxProviderName()];
}

/** 全部提供方（设置页列出可选项与是否已配置凭据）。 */
export function listSandboxProviders(): SandboxProvider[] {
  return Object.values(PROVIDERS);
}

export { DEFAULT_SANDBOX_LIFECYCLE } from './types';
export {
  ALLOW_ENTRY_RE,
  ALLOW_LIST_MAX,
  DEFAULT_SANDBOX_NETWORK,
  normalizeAllowList,
  SANDBOX_EGRESS_MODES,
  SandboxNetworkUnsupportedError,
} from './network';
export type { SandboxEgressMode, SandboxNetwork } from './network';
export type {
  ConnectedSandbox,
  GuardableSandbox,
  PortUpstream,
  SandboxLifecycle,
  SandboxListing,
  SandboxProvider,
  SandboxProviderName,
  UserSandboxConfig,
} from './types';
