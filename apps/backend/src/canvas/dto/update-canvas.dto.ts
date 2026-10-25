import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** PATCH /canvas/:id：重命名 / 置顶 / 测试模式，字段都可选，只改传了的那个。空白标题由 service 拒绝。 */
export class UpdateCanvasDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  /** 列表置顶 / 取消置顶。 */
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  /** 测试模式（Mock）开关：之后本画布触发的生成走本地占位素材。环境禁用时开启被拒。 */
  @IsOptional()
  @IsBoolean()
  mockMedia?: boolean;
}
