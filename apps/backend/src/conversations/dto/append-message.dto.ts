import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ALLOWED_MODELS } from '../../agent/models';

export class AppendMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  /** 回答模型（前端可选）；缺省/非法时 worker 回退 env 默认。 */
  @IsOptional()
  @IsIn(ALLOWED_MODELS as unknown as string[])
  model?: string;
}
