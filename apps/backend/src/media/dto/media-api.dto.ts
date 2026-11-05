import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** desktop 会话 id（本机 UUID）：只收字母、数字、连字符，拼成 `desktop:<scope>` 记账 */
export const DESKTOP_SCOPE_RE = /^[A-Za-z0-9-]{1,64}$/;

export class MediaApiModelsQuery {
  @IsIn(['image', 'video', 'audio'])
  type!: 'image' | 'video' | 'audio';
}

export class MediaApiScopeQuery {
  @Matches(DESKTOP_SCOPE_RE)
  scope!: string;
}

/** POST /media-api/generations：入参同对话 agent 的 generate_* 工具（agent-core media-tools） */
export class MediaApiGenerateDto {
  @Matches(DESKTOP_SCOPE_RE)
  scope!: string;

  @IsIn(['image', 'video', 'audio'])
  type!: 'image' | 'video' | 'audio';

  @IsString()
  @MaxLength(2000)
  prompt!: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  // 取值交给 MediaService 按模型目录严格校验（同工具），这里只要求是对象
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  referenceVersionIds?: string[];

  // 越界交给 service 回可改正的 issues（同工具），这里只挡明显的非法值
  @IsInt()
  @Min(0)
  @Max(100)
  count!: number;
}

/** POST /media-api/sources：同 sync_media_to_sandbox，取本会话媒体的下载来源 */
export class MediaApiSourcesDto {
  @Matches(DESKTOP_SCOPE_RE)
  scope!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  versionIds!: string[];
}

/** POST /media-api/voices：入参同 clone_voice 工具 */
export class MediaApiCloneVoiceDto {
  @Matches(DESKTOP_SCOPE_RE)
  scope!: string;

  @IsString()
  sourceVersionId!: string;

  @IsString()
  language!: string;

  @IsString()
  @MaxLength(200)
  demoText!: string;
}
