import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { ALLOWED_MODELS } from '../../agent/models';
import { THINKING_LEVELS } from '../../agent/thinking-level';
import { ATTACHMENTS_MAX } from '../../media/media-upload.service';

export class AppendMessageDto {
  /** 消息正文；带附件时可为空（正文与附件至少一项，service 层校验）。 */
  @IsOptional()
  @IsString()
  content?: string;

  /** 随本条消息发出的上传附件（POST /conversations/:id/uploads 返回的 versionId，仍为 staged）。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ATTACHMENTS_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  attachmentVersionIds?: string[];

  /** 回答模型（前端可选）；缺省/非法时 worker 回退 env 默认。 */
  @IsOptional()
  @IsIn(ALLOWED_MODELS)
  model?: string;

  /** 思考深度档位（可选）；缺省沿用会话既有档位（无则 auto）。各家能力见 agent/thinking-level.ts。 */
  @IsOptional()
  @IsIn(THINKING_LEVELS)
  thinkingLevel?: string;
}
