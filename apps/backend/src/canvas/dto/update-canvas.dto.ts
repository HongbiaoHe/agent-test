import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** PATCH /canvas/:id：重命名 / 置顶，两个字段都可选，只改传了的那个。空白标题由 service 拒绝。 */
export class UpdateCanvasDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  /** 列表置顶 / 取消置顶。 */
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
