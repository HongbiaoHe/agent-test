import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ALLOWED_MODELS } from '../../agent/models';
import { THINKING_LEVELS } from '../../agent/thinking-level';

export class AppendMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  /** 回答模型（前端可选）；缺省/非法时 worker 回退 env 默认。 */
  @IsOptional()
  @IsIn(ALLOWED_MODELS)
  model?: string;

  /** 思考深度档位（可选）；缺省沿用会话既有档位（无则 auto）。各家能力见 agent/thinking-level.ts。 */
  @IsOptional()
  @IsIn(THINKING_LEVELS)
  thinkingLevel?: string;
}
