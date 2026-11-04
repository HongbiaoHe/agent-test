import { IsIn, IsObject, IsOptional } from 'class-validator';
// 直接引 sizes.ts（纯逻辑），不走 sandbox-providers 入口：入口会连带加载 E2B / Daytona SDK
import {
  SANDBOX_SIZES,
  type SandboxSizeId,
} from '../../agent/sandbox-providers/sizes';

/** POST /sandbox/size：换到这一档（建新沙箱并迁移工作区）。 */
export class SwitchSandboxSizeDto {
  @IsIn(SANDBOX_SIZES.map((s) => s.id))
  size!: SandboxSizeId;

  /** 迁移时排除的文件 / 文件夹（paths）与扩展名（exts）；细节校验在 normalizeExcludes */
  @IsOptional()
  @IsObject()
  excludes?: object;
}

/** POST /sandbox/inventory/estimate：按这份排除项统计将迁移多少 */
export class EstimateMigrationDto {
  @IsOptional()
  @IsObject()
  excludes?: object;
}
