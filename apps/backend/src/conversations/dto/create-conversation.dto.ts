import { IsIn, IsOptional, IsString } from 'class-validator';
import { ALLOWED_MODELS } from '../../agent/models';

export class CreateConversationDto {
  /** 可缺省：缺省时创建 idle 空会话（先建会话再进入，首条消息时才入队）。 */
  @IsOptional()
  @IsString()
  goal?: string;

  /** 回答模型（前端可选）；缺省/非法时 worker 回退 env 默认。 */
  @IsOptional()
  @IsIn(ALLOWED_MODELS)
  model?: string;
}
