import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
// 直接引 network.ts（纯逻辑），不走 sandbox-providers 入口：入口会连带加载 E2B / Daytona SDK
import {
  ALLOW_ENTRY_RE,
  ALLOW_LIST_MAX,
  SANDBOX_EGRESS_MODES,
  type SandboxEgressMode,
} from '../../agent/sandbox-providers/network';
import type { SandboxProviderName } from '../../agent/sandbox-providers/types';

const PROVIDER_NAMES: SandboxProviderName[] = ['daytona', 'e2b'];

/** PATCH /sandbox/settings：局部更新，未传字段保持不变。 */
export class UpdateSandboxSettingsDto {
  /** 提供方；null = 跟随服务端默认（env SANDBOX_PROVIDER）。 */
  @IsOptional()
  @IsIn(PROVIDER_NAMES)
  provider?: SandboxProviderName | null;

  /** 闲置多少分钟后自动停机/暂停：1–60（E2B Hobby 单次运行上限 1 小时）。 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  idleMinutes?: number;

  /**
   * 停机后多少分钟自动删除（仅 Daytona）：-1 = 永不删除，或 1–10080（7 天）。
   * 拒绝 0：Daytona 的 0 表示「停机即删」，会丢工作区文件。
   */
  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(10080)
  @NotEquals(0)
  autoDeleteMinutes?: number;

  /** 出站网络：open 全放行 / allowlist 仅白名单 / blocked 全禁止。 */
  @IsOptional()
  @IsIn(SANDBOX_EGRESS_MODES)
  egressMode?: SandboxEgressMode;

  /** 出站白名单：域名（可 `*.` 通配）/ IPv4 / IPv4 CIDR，最多 50 条（整体替换）。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ALLOW_LIST_MAX)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  @Matches(ALLOW_ENTRY_RE, { each: true })
  allowList?: string[];

  /** 端口公网地址免鉴权访问（仅 E2B，对之后新建的沙箱生效）。 */
  @IsOptional()
  @IsBoolean()
  publicTraffic?: boolean;
}
