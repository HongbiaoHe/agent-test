import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { ALLOWED_MODELS } from '../../agent/models';
import { THINKING_LEVELS } from '../../agent/thinking-level';

/**
 * POST /modes、PUT /modes/:id、POST /modes/preview 的请求体：这里只做外层形状；
 * 去空白、长度、占位符等语义校验在 ModesService 里经 core 的 AgentModeInputSchema 完成。
 */
export class ModeInputDto {
  @IsString()
  name!: string;

  @IsString()
  systemPrompt!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mcpServerIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillNames?: string[];

  /** 新建会话时回填的默认模型；null / 缺省 = 跟随会话选择 */
  @IsOptional()
  @IsIn(ALLOWED_MODELS)
  defaultModel?: string | null;

  @IsOptional()
  @IsIn(THINKING_LEVELS)
  defaultThinkingLevel?: string | null;
}

/**
 * PUT /modes/general 的请求体（整体替换）。systemPrompt 必须显式给出：字符串 = 自定义，
 * null = 恢复默认；非空、长度、占位符等语义校验在 ModesService 里经 core 的 GeneralModeSettingsSchema 完成。
 */
export class GeneralModeInputDto {
  @ValidateIf((o: GeneralModeInputDto) => o.systemPrompt !== null)
  @IsString()
  systemPrompt!: string | null;

  @IsOptional()
  @IsIn(ALLOWED_MODELS)
  defaultModel?: string | null;

  @IsOptional()
  @IsIn(THINKING_LEVELS)
  defaultThinkingLevel?: string | null;
}

/** POST /modes/general/preview 的请求体：只预览提示词（null = 默认提示词）。 */
export class GeneralModePreviewDto {
  @ValidateIf((o: GeneralModePreviewDto) => o.systemPrompt !== null)
  @IsString()
  systemPrompt!: string | null;
}
