import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CANVAS_APPROVAL_MODES, CANVAS_MODELS } from '../canvas.types';
import { CANVAS_THINKING_LEVELS } from '../thinking-level';

export class AppendCanvasMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  @IsIn(CANVAS_MODELS)
  model?: string;

  /** 思考深度档位（可选）；缺省沿用会话既有档位/模型默认。各家能力见 thinking-level.ts。 */
  @IsOptional()
  @IsIn(CANVAS_THINKING_LEVELS)
  thinkingLevel?: string;

  /** 敏感操作审批模式：review | auto。不传保留会话既有设置。 */
  @IsOptional()
  @IsIn(CANVAS_APPROVAL_MODES)
  approvalMode?: string;
}
