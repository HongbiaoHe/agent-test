import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MCP_SCOPES,
  type McpScope,
  PAT_EXPIRY_DAYS,
} from '../mcp-server.config';

/** 新建个人访问令牌（PAT） */
export class CreatePatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(MCP_SCOPES, { each: true })
  scopes!: McpScope[];

  /** 有效期（天）；不传 = 永不过期 */
  @IsOptional()
  @IsIn(PAT_EXPIRY_DAYS)
  expiresInDays?: (typeof PAT_EXPIRY_DAYS)[number];
}
