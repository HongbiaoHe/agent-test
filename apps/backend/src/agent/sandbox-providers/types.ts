/**
 * 沙箱提供方（provider）抽象：Daytona / E2B 各实现一份，sandbox.ts 按配置
 * （SANDBOX_PROVIDER）选择其一。上层（worker / conversations / 状态接口）只认
 * sandbox.ts 的函数与 GuardedSandbox，不感知具体提供方。
 */

import type { BaseSandbox } from 'deepagents';
import type { SandboxNetwork } from './network';

export type SandboxProviderName = 'daytona' | 'e2b';

/**
 * 提供方 list 结果的统一形状（状态接口与 pickPreferredSandbox 用）。
 * state 统一为 Daytona 口径：'started' = 运行中，'stopped' = 停机/暂停（可拉起），
 * 其余为过渡/异常态——前端与选择规则都按这套字符串判断。
 */
export interface SandboxListing {
  id: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  autoStopInterval?: number;
  autoDeleteInterval?: number;
  /**
   * 远端当前出站策略指纹（network.ts egressSignature 口径）。取不到时缺省 = 未知，按需要同步处理
   * （E2B 的 list 结果不含网络信息，只有 getInfo 有）。
   */
  egress?: string;
  /** 端口公网地址当前是否免鉴权（list 结果里有就带上；E2B 没有，见 inspectPublicTraffic） */
  publicTraffic?: boolean;
  /** 规格（list 结果自带，不需连沙箱）：vCPU 数、内存 MB、磁盘 GB（E2B 的 list 不含磁盘） */
  cpuCount?: number;
  memoryMB?: number;
  diskGB?: number;
}

/**
 * GuardedSandbox 能包装的 inner：deepagents BaseSandbox（execute/upload/download +
 * 基于 shell 的文件工具）+ 宿主侧生命周期方法。DaytonaSandbox 与 E2BSandbox 均满足。
 */
export type GuardableSandbox = BaseSandbox & {
  readonly isRunning: boolean;
  start(timeout?: number): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  /**
   * 一轮 agent 运行期间由 worker 定期调用（30s），把闲置计时推到「现在 + 闲置时长」。
   * E2B 的超时是绝对时长、只在文件/命令操作前续期：模型思考或长命令执行超过闲置时长，
   * 沙箱会在轮内暂停、后续工具调用全部失败——闲置 1 分钟时这是常态而非偶发。
   * 不需要的提供方（Daytona 由服务端按活动计时）不实现。
   */
  heartbeat?(): Promise<void>;
};

/**
 * 沙箱生命周期设置（用户在 /settings/sandbox 配置）。
 * - idleMinutes：闲置多少分钟后自动停机（Daytona）/ 暂停（E2B）
 * - autoDeleteMinutes：停机后多少分钟自动删除，-1 = 永不删除（仅 supportsAutoDelete 的提供方生效）
 */
export interface SandboxLifecycle {
  idleMinutes: number;
  autoDeleteMinutes: number;
}

/**
 * 未设置时的默认值（与改造前 Daytona 的写死配置一致）。各提供方的实际默认见
 * SandboxProvider.lifecycleDefaults（E2B 闲置更短）；这里是无提供方上下文时的兜底。
 */
export const DEFAULT_SANDBOX_LIFECYCLE: SandboxLifecycle = {
  idleMinutes: 5,
  autoDeleteMinutes: 10,
};

/** 某用户生效的沙箱配置（SandboxSettingsService 从用户设置解析）。 */
export interface UserSandboxConfig {
  provider: SandboxProviderName;
  lifecycle: SandboxLifecycle;
  network: SandboxNetwork;
}

/** 已连接（且处于运行态）的沙箱 + 其 home 目录（工作区建在 home 下）。 */
export interface ConnectedSandbox {
  inner: GuardableSandbox;
  homeDir: string;
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  /** 用户未设置时该提供方的生命周期默认值（设置页展示、resolve 兜底）。 */
  readonly lifecycleDefaults: SandboxLifecycle;
  /** 是否支持「停机后自动删除」（E2B 暂停态永久保留，不支持） */
  readonly supportsAutoDelete: boolean;
  /**
   * 能否按沙箱设置出站规则。不能时（如 Daytona Tier 1/2，组织级策略优先）用户的出站设置
   * 对该提供方不生效，按 open 处理（实际出站由提供方组织策略决定）。
   */
  readonly supportsEgressControl: boolean;
  /** 出站白名单是否支持域名（Daytona 只支持 IP/CIDR） */
  readonly supportsDomainAllowList: boolean;
  /** 是否可配置端口公网地址免鉴权（Daytona 预览链接始终需令牌，不提供） */
  readonly supportsPublicTrafficToggle: boolean;
  /** 凭据是否已配置；未配置时上层回退 StateBackend（无沙箱）。 */
  isConfigured(): boolean;
  /** 列出该用户的全部沙箱。只读：不唤醒、不续命（状态心跳每 15s 调一次）。 */
  listUserSandboxes(userId: string): Promise<SandboxListing[]>;
  /** 连接已有沙箱；非运行态先拉起再返回。生命周期与 listing 不一致时顺带更新。 */
  connect(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<ConnectedSandbox>;
  /** 为该用户新建沙箱（绑 user_id 标签/元数据）。 */
  create(
    userId: string,
    lifecycle: SandboxLifecycle,
    network: SandboxNetwork,
  ): Promise<ConnectedSandbox>;
  /** 用户网络设置对应的出站策略指纹；与 listing.egress 相等即远端已同步。 */
  desiredEgress(network: SandboxNetwork): string;
  /** 把出站规则应用到运行中的沙箱（运行中生效，不重启）。失败抛错。 */
  applyEgress(listing: SandboxListing, network: SandboxNetwork): Promise<void>;
  /** 查询沙箱端口公网地址当前是否免鉴权（设置页展示「当前沙箱」实际值）。 */
  inspectPublicTraffic(listing: SandboxListing): Promise<boolean>;
  /**
   * 把生命周期设置应用到已有沙箱（用户改设置后立即生效）。
   * 不唤醒停机/暂停中的沙箱：只改远端配置。
   */
  applyLifecycle(
    listing: SandboxListing,
    lifecycle: SandboxLifecycle,
  ): Promise<void>;
  /**
   * 沙箱端口的上游地址（端口预览反代用，见 preview 模块）：origin = 提供方给该端口的公网地址，
   * headers = 访问它必须带的请求头（私有沙箱的访问令牌等）。令牌只放请求头、由后端反代代带，
   * 绝不下发给浏览器。沙箱须已运行。
   */
  portUpstream(sandboxId: string, port: number): Promise<PortUpstream>;
  /**
   * 让运行中的沙箱保持活跃（用户正在用预览时调用，调用方负责节流）。
   * 预览流量直接打到提供方的端口地址、或只读文件，提供方都不把它算作活跃
   * （2026-10-17 实测 E2B：持续访问端口预览，到期时间照样线性减少），不续就会在用户操作中途停机/暂停。
   */
  keepAlive(sandboxId: string, lifecycle: SandboxLifecycle): Promise<void>;
  /** 图形桌面（noVNC）。不支持的提供方不提供该字段。 */
  desktop?: {
    /** 启动桌面并返回 noVNC 地址（沙箱须已运行）。 */
    start(sandboxId: string): Promise<string>;
    stop(sandboxId: string): Promise<void>;
  };
}

/** 沙箱端口的上游：反代把请求转到 `${origin}${path}` 并附上 headers。 */
export interface PortUpstream {
  origin: string;
  headers: Record<string, string>;
}
