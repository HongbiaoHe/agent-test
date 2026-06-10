import { IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /media/generations/:id/regenerate 请求体；prompt 缺省时沿用上一版。 */
export class RegenerateMediaDto {
  // 设计 §安全：prompt 上限 2000 字符；缺省路径只服务 API 直调（前端总是回传当前值）。
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;
}
