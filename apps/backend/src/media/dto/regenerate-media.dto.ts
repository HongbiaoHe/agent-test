import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** POST /media/generations/:id/regenerate 请求体；prompt 缺省时沿用上一版。 */
export class RegenerateMediaDto {
  // 设计 §安全：prompt 上限 2000 字符；缺省路径只服务 API 直调（前端总是回传当前值）。
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;

  // 参考图：缺省时由 service 继承上一版（前端不传则沿用）；显式传入则覆盖，上限 4 张。
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(4)
  referenceVersionIds?: string[];
}
