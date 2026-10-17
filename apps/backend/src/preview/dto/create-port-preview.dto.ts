import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** POST /preview/port：为用户沙箱里的一个端口签发预览地址。 */
export class CreatePortPreviewDto {
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  /** 应用内路径（如 `/dashboard`），缺省 `/` */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^\//, { message: 'path 必须以 / 开头' })
  path?: string;
}
