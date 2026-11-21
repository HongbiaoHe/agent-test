import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DESKTOP_SCOPE_RE } from '../../media/dto/media-api.dto';

/** 运行锁持锁方标识：desktop 每轮运行生成一个（UUID 等），只收字母、数字、连字符 */
const HOLDER_RE = /^[A-Za-z0-9-]{8,64}$/;

/** 申请 / 续期运行锁 */
export class CanvasAgentLockDto {
  @Matches(HOLDER_RE)
  holderId!: string;

  /** 给其它端显示的说明（desktop 对话标题） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

/** 释放运行锁 */
export class CanvasAgentUnlockDto {
  @Matches(HOLDER_RE)
  holderId!: string;
}

/** 以 agent 身份提交一次结构变更（必须持锁）；op 的形状由 canvasAgentOpSchema 收窄 */
export class CanvasAgentOpDto {
  @Matches(HOLDER_RE)
  holderId!: string;

  @IsObject()
  op!: Record<string, unknown>;
}

class ReferenceCountsDto {
  @IsInt()
  @Min(0)
  image!: number;

  @IsInt()
  @Min(0)
  video!: number;

  @IsInt()
  @Min(0)
  audio!: number;
}

/** 给生成节点设模型前的严格校验（同服务端 agent 的 set_node_model） */
export class CanvasAgentNodeConfigDto {
  @IsIn(['image', 'video'])
  type!: 'image' | 'video';

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  channel?: string;

  // 取值交给 AigcService 按模型目录严格校验，这里只要求是对象
  @IsOptional()
  @IsObject()
  params?: Record<string, string>;

  @ValidateNested()
  @Type(() => ReferenceCountsDto)
  referenceCounts!: ReferenceCountsDto;
}

class NodeConfigDto {
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, string>;
}

/** 发起一次生成（必须持锁），记在这块画布名下（与服务端 agent、用户手动触发一样） */
export class CanvasAgentGenerationDto {
  @Matches(HOLDER_RE)
  holderId!: string;

  @IsIn(['image', 'video'])
  type!: 'image' | 'video';

  @IsString()
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  referenceVersionIds?: string[];

  @ValidateNested()
  @Type(() => NodeConfigDto)
  config!: NodeConfigDto;
}

/** 发起一次视频拼接（必须持锁） */
export class CanvasAgentConcatDto {
  @Matches(HOLDER_RE)
  holderId!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  sources!: string[];
}

/** desktop 对话里的附件（上传版本）：按 desktop 会话记账范围查 */
export class CanvasAgentUploadedAssetDto {
  @Matches(DESKTOP_SCOPE_RE)
  scope!: string;

  @IsString()
  @MaxLength(64)
  versionId!: string;
}
