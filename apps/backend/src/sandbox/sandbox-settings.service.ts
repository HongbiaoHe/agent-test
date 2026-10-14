import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { pickUserSandbox } from '../agent/sandbox';
import {
  DEFAULT_SANDBOX_LIFECYCLE,
  DEFAULT_SANDBOX_NETWORK,
  defaultSandboxProviderName,
  getSandboxProvider,
  isSandboxProviderName,
  listSandboxProviders,
  normalizeAllowList,
  SANDBOX_EGRESS_MODES,
  SandboxNetworkUnsupportedError,
  type SandboxEgressMode,
  type SandboxLifecycle,
  type SandboxNetwork,
  type SandboxProviderName,
  type UserSandboxConfig,
} from '../agent/sandbox-providers';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateSandboxSettingsDto } from './dto/update-sandbox-settings.dto';

/** GET/PATCH /sandbox/settings 的响应形状（/settings/sandbox 页面渲染用）。 */
export interface SandboxSettings {
  /** 实际生效的提供方（worker / 文件接口 / 沙箱面板都用它） */
  current: SandboxProviderName;
  /** 用户显式选择；null = 跟随服务端默认 */
  preference: SandboxProviderName | null;
  /** 服务端默认（env SANDBOX_PROVIDER） */
  default: SandboxProviderName;
  providers: Array<{
    name: SandboxProviderName;
    /** 服务端是否配置了该提供方的 API key；未配置的不可选 */
    configured: boolean;
    desktopSupported: boolean;
    supportsAutoDelete: boolean;
    supportsEgressControl: boolean;
    supportsDomainAllowList: boolean;
    supportsPublicTrafficToggle: boolean;
  }>;
  /** 生效的生命周期设置（未设置项取默认） */
  lifecycle: SandboxLifecycle;
  lifecycleDefaults: SandboxLifecycle;
  /** 生效的网络设置（未设置项取默认） */
  network: SandboxNetwork;
  networkDefaults: SandboxNetwork;
  /**
   * 当前提供方下该用户现有沙箱的端口公网地址是否免鉴权（实际值；入站设置只在创建时生效，
   * 可能与 network.publicTraffic 不一致）。无沙箱 / 查询失败为 null。
   */
  currentPublicTraffic: boolean | null;
  /**
   * 仅 PATCH 改了出站设置时返回：applied = 已应用到运行中的沙箱；pending = 沙箱未运行/不存在，
   * 下次 agent 运行时同步；failed = 应用失败（下次运行时重试，再失败则该轮不使用沙箱）。
   */
  egressSync?: 'applied' | 'pending' | 'failed';
}

/** 库里读出的原始设置行（null = 未设置）。 */
interface StoredSettings {
  sandboxProvider: string | null;
  sandboxIdleMinutes: number | null;
  sandboxAutoDeleteMinutes: number | null;
  sandboxNetworkMode: string | null;
  sandboxNetworkAllowList: Prisma.JsonValue;
  sandboxPublicTraffic: boolean | null;
}

function isEgressMode(v: string): v is SandboxEgressMode {
  return SANDBOX_EGRESS_MODES.some((m) => m === v);
}

/**
 * 用户级沙箱设置（User.sandboxProvider / sandboxIdleMinutes / sandboxAutoDeleteMinutes）。
 *
 * 提供方生效规则：用户偏好合法且该提供方凭据已配置 → 用偏好；否则回退 env 默认。
 * 回退而不是报错：偏好设置后服务端可能撤掉某家 key，此时继续用默认提供方比整轮无沙箱更好。
 * 生命周期：未设置项取 DEFAULT_SANDBOX_LIFECYCLE；保存后立即尽力应用到现有沙箱。
 * 网络：出站保存后立即应用到运行中的沙箱（未运行则由下次 getUserSandbox 同步）；
 * 入站 publicTraffic 仅 E2B 可配、只在创建沙箱时生效。
 */
@Injectable()
export class SandboxSettingsService {
  private readonly logger = new Logger(SandboxSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 该用户生效的沙箱配置（worker / 文件接口 / 状态接口用）。 */
  async resolve(userId: string): Promise<UserSandboxConfig> {
    const row = await this.read(userId);
    const provider = this.effectiveProvider(row);
    const network = this.effectiveNetwork(row);
    return {
      provider,
      lifecycle: this.effectiveLifecycle(row),
      // 提供方不支持沙箱级出站策略：用户的出站设置对它不生效（保留给 E2B），按 open 处理，
      // 否则每轮下发都会被拒、整轮降级成无沙箱
      network: getSandboxProvider(provider).supportsEgressControl
        ? network
        : { ...network, egress: 'open' },
    };
  }

  async getSettings(userId: string): Promise<SandboxSettings> {
    const settings = this.toSettings(await this.read(userId));
    settings.currentPublicTraffic = await this.inspectCurrentPublicTraffic(
      userId,
      settings.current,
    );
    return settings;
  }

  /** 现有沙箱入站实际值：只读查询，不唤醒；任何失败按未知（null）处理。 */
  private async inspectCurrentPublicTraffic(
    userId: string,
    provider: SandboxProviderName,
  ): Promise<boolean | null> {
    try {
      const p = getSandboxProvider(provider);
      if (!p.isConfigured()) return null;
      const existing = await pickUserSandbox(userId, provider);
      return existing ? await p.inspectPublicTraffic(existing) : null;
    } catch (e) {
      this.logger.warn(`沙箱入站状态查询失败 userId=${userId}: ${String(e)}`);
      return null;
    }
  }

  /**
   * 局部更新（未传字段保持不变；provider 传 null = 跟随默认）。
   * 选择未配置凭据的提供方 → 400。保存后把生命周期应用到该用户当前提供方的沙箱（失败只记日志）。
   */
  async update(
    userId: string,
    dto: UpdateSandboxSettingsDto,
  ): Promise<SandboxSettings> {
    if (dto.provider && !getSandboxProvider(dto.provider).isConfigured()) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_PROVIDER_NOT_CONFIGURED,
        HttpStatus.BAD_REQUEST,
      );
    }
    const before = await this.read(userId);
    // 目标提供方不支持沙箱级出站策略时，拒绝设置出站限制（提前拦截，而不是等运行时被拒）
    const target = getSandboxProvider(
      dto.provider ?? this.effectiveProvider(before),
    );
    if (
      dto.egressMode !== undefined &&
      dto.egressMode !== 'open' &&
      !target.supportsEgressControl
    ) {
      throw new BusinessException(
        ErrorCodes.SANDBOX_NETWORK_UNSUPPORTED,
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.provider !== undefined && { sandboxProvider: dto.provider }),
        ...(dto.idleMinutes !== undefined && {
          sandboxIdleMinutes: dto.idleMinutes,
        }),
        ...(dto.autoDeleteMinutes !== undefined && {
          sandboxAutoDeleteMinutes: dto.autoDeleteMinutes,
        }),
        ...(dto.egressMode !== undefined && {
          sandboxNetworkMode: dto.egressMode,
        }),
        ...(dto.allowList !== undefined && {
          sandboxNetworkAllowList: normalizeAllowList(dto.allowList),
        }),
        ...(dto.publicTraffic !== undefined && {
          sandboxPublicTraffic: dto.publicTraffic,
        }),
      },
    });
    const settings = await this.getSettings(userId);
    if (dto.idleMinutes !== undefined || dto.autoDeleteMinutes !== undefined) {
      await this.applyToExisting(userId, settings.current, settings.lifecycle);
    }
    // 切换提供方也要同步：新提供方的现有沙箱可能还是旧规则。
    // 不支持沙箱级出站策略的提供方不下发（出站由其组织策略决定），也就没有同步状态可报
    if (
      (dto.egressMode !== undefined ||
        dto.allowList !== undefined ||
        dto.provider !== undefined) &&
      getSandboxProvider(settings.current).supportsEgressControl
    ) {
      try {
        settings.egressSync = await this.applyEgressToRunning(
          userId,
          settings.current,
          settings.network,
        );
      } catch (e) {
        if (!(e instanceof SandboxNetworkUnsupportedError)) throw e;
        // 提供方根本不允许这条出站策略：回滚本次改动的字段，避免设置停留在「看似生效、实际不生效」
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            ...(dto.provider !== undefined && {
              sandboxProvider: before?.sandboxProvider ?? null,
            }),
            ...(dto.egressMode !== undefined && {
              sandboxNetworkMode: before?.sandboxNetworkMode ?? null,
            }),
            ...(dto.allowList !== undefined && {
              sandboxNetworkAllowList: before?.sandboxNetworkAllowList ?? [],
            }),
          },
        });
        throw new BusinessException(
          ErrorCodes.SANDBOX_NETWORK_UNSUPPORTED,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return settings;
  }

  /**
   * 出站规则应用到运行中的沙箱。停机/暂停中的不唤醒（pending），下次 agent 运行时
   * getUserSandbox 发现指纹不一致会先同步；已一致直接视为 applied。
   */
  private async applyEgressToRunning(
    userId: string,
    provider: SandboxProviderName,
    network: SandboxNetwork,
  ): Promise<'applied' | 'pending' | 'failed'> {
    try {
      const p = getSandboxProvider(provider);
      if (!p.isConfigured()) return 'pending';
      const existing = await pickUserSandbox(userId, provider);
      if (!existing) return 'pending';
      if (existing.egress === p.desiredEgress(network)) return 'applied';
      if (existing.state !== 'started') return 'pending';
      await p.applyEgress(existing, network);
      return 'applied';
    } catch (e) {
      // 「不支持」不是偶发失败：交给 update 回滚并提示
      if (e instanceof SandboxNetworkUnsupportedError) throw e;
      this.logger.warn(`沙箱出站规则应用失败 userId=${userId}: ${String(e)}`);
      return 'failed';
    }
  }

  /** 把新生命周期应用到现有沙箱：不唤醒；失败不影响保存（下次连接时也会同步）。 */
  private async applyToExisting(
    userId: string,
    provider: SandboxProviderName,
    lifecycle: SandboxLifecycle,
  ): Promise<void> {
    try {
      const p = getSandboxProvider(provider);
      if (!p.isConfigured()) return;
      const existing = await pickUserSandbox(userId, provider);
      if (existing) await p.applyLifecycle(existing, lifecycle);
    } catch (e) {
      this.logger.warn(`沙箱生命周期应用失败 userId=${userId}: ${String(e)}`);
    }
  }

  private toSettings(row: StoredSettings | null): SandboxSettings {
    return {
      current: this.effectiveProvider(row),
      preference: this.preference(row),
      default: defaultSandboxProviderName(),
      providers: listSandboxProviders().map((p) => ({
        name: p.name,
        configured: p.isConfigured(),
        desktopSupported: !!p.desktop,
        supportsAutoDelete: p.supportsAutoDelete,
        supportsEgressControl: p.supportsEgressControl,
        supportsDomainAllowList: p.supportsDomainAllowList,
        supportsPublicTrafficToggle: p.supportsPublicTrafficToggle,
      })),
      lifecycle: this.effectiveLifecycle(row),
      lifecycleDefaults: DEFAULT_SANDBOX_LIFECYCLE,
      network: this.effectiveNetwork(row),
      networkDefaults: DEFAULT_SANDBOX_NETWORK,
      currentPublicTraffic: null,
    };
  }

  /** 历史脏值（非法名）按未设置处理。 */
  private preference(row: StoredSettings | null): SandboxProviderName | null {
    const raw = row?.sandboxProvider;
    return raw && isSandboxProviderName(raw) ? raw : null;
  }

  private effectiveProvider(row: StoredSettings | null): SandboxProviderName {
    const pref = this.preference(row);
    return pref && getSandboxProvider(pref).isConfigured()
      ? pref
      : defaultSandboxProviderName();
  }

  private effectiveLifecycle(row: StoredSettings | null): SandboxLifecycle {
    return {
      idleMinutes:
        row?.sandboxIdleMinutes ?? DEFAULT_SANDBOX_LIFECYCLE.idleMinutes,
      autoDeleteMinutes:
        row?.sandboxAutoDeleteMinutes ??
        DEFAULT_SANDBOX_LIFECYCLE.autoDeleteMinutes,
    };
  }

  /** 历史脏值（非法模式 / 非字符串数组）按未设置处理。 */
  private effectiveNetwork(row: StoredSettings | null): SandboxNetwork {
    const mode = row?.sandboxNetworkMode;
    const list = row?.sandboxNetworkAllowList;
    return {
      egress:
        mode && isEgressMode(mode) ? mode : DEFAULT_SANDBOX_NETWORK.egress,
      allowList: Array.isArray(list)
        ? list.filter((e): e is string => typeof e === 'string')
        : DEFAULT_SANDBOX_NETWORK.allowList,
      publicTraffic:
        row?.sandboxPublicTraffic ?? DEFAULT_SANDBOX_NETWORK.publicTraffic,
    };
  }

  private read(userId: string): Promise<StoredSettings | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        sandboxProvider: true,
        sandboxIdleMinutes: true,
        sandboxAutoDeleteMinutes: true,
        sandboxNetworkMode: true,
        sandboxNetworkAllowList: true,
        sandboxPublicTraffic: true,
      },
    });
  }
}
