import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { CANVAS_APPROVAL_MODES, CANVAS_MODELS } from '../canvas.types';
import { THINKING_LEVELS } from '../../agent/thinking-level';
import { ATTACHMENTS_MAX } from '../../media/media-upload.service';

export class AppendCanvasMessageDto {
  /** 消息正文；带附件时可为空（正文与附件至少一项，service 层校验）。 */
  @IsOptional()
  @IsString()
  content?: string;

  /** 随本条消息发出的上传附件（POST /canvas/:id/uploads 返回的 versionId，仍为 staged）。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ATTACHMENTS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  attachmentVersionIds?: string[];

  @IsOptional()
  @IsIn(CANVAS_MODELS)
  model?: string;

  /** 思考深度档位（可选）；缺省沿用会话既有档位/模型默认。各家能力见 thinking-level.ts。 */
  @IsOptional()
  @IsIn(THINKING_LEVELS)
  thinkingLevel?: string;

  /** 敏感操作审批模式：review | auto。不传保留会话既有设置。 */
  @IsOptional()
  @IsIn(CANVAS_APPROVAL_MODES)
  approvalMode?: string;
}
