import { IsIn, IsOptional, IsString } from 'class-validator';
import { CANVAS_MODELS } from '../canvas.types';
import { CANVAS_THINKING_LEVELS } from '../thinking-level';

export class CreateCanvasDto {
  /** 可缺省：缺省创建 idle 空画布；有则作为首轮目标入队跑 agent。 */
  @IsOptional()
  @IsString()
  goal?: string;

  /** 画布标题（可选）。 */
  @IsOptional()
  @IsString()
  title?: string;

  /** agent 模型（可选）；缺省/非法时 worker 回退 env 默认。 */
  @IsOptional()
  @IsIn(CANVAS_MODELS)
  model?: string;

  /** 思考深度档位（可选）；缺省沿用会话既有档位/模型默认。各家能力见 thinking-level.ts。 */
  @IsOptional()
  @IsIn(CANVAS_THINKING_LEVELS)
  thinkingLevel?: string;
}
