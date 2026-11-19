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

  /** 被别的模式当作子 agent 时的用途说明；null / 缺省 = 用模式名 + 提示词开头 */
  @IsOptional()
  @ValidateIf((o: ModeInputDto) => o.description !== null)
  @IsString()
  description?: string | null;

  /** 勾作子 agent 的其它模式 id（须是本人的、不能是自己） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  subagentModeIds?: string[];
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

/**
 * PUT /modes/fragments/:fragmentId 的请求体，按片段种类解释（语义校验在 ModesService 里经 core 完成）：
 * - 内置 platform.*：text 必须显式给出，字符串 = 改写，null = 恢复默认；不接受 title；
 * - 自建 custom.*：title / text 至少给一个；text 不能为 null（没有默认正文可恢复）。
 */
export class FragmentInputDto {
  @IsOptional()
  @IsString()
  title?: string;

  @ValidateIf((o: FragmentInputDto) => o.text != null)
  @IsString()
  text?: string | null;
}

/**
 * POST /modes/fragments 的请求体：新建自建片段。id 格式（custom.<名字>）、title / 正文长度、
 * 变量（只允许 {{skills_dir}}）等语义校验在 ModesService 里经 core 完成。
 */
export class CreateFragmentDto {
  @IsString()
  id!: string;

  @IsString()
  title!: string;

  @IsString()
  text!: string;
}
