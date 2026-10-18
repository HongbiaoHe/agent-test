import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** PATCH /conversations/:id：两个字段都可选，只改传了的那个。 */
export class UpdateConversationDto {
  /** 侧栏置顶 / 取消置顶。 */
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  /** 重命名（去掉首尾空白后最多 200 字）；空串 = 清除自定义标题，回退显示首条消息。 */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  title?: string;
}
