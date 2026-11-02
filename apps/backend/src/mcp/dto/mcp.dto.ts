import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { ToolPermission } from '../mcp-types';

export class CreateMcpServerDto {
  @IsString()
  @MaxLength(512)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class UpdateMcpServerDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** { [toolName]: allow | ask | deny }；值在 service 层再按 TOOL_PERMISSIONS 校验一遍 */
  @IsOptional()
  @IsObject()
  toolPermissions?: Record<string, ToolPermission>;
}

export class AppCallToolDto {
  @IsString()
  serverId!: string;

  @IsString()
  @MaxLength(256)
  name!: string;

  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  /** 需审批的工具：前端弹窗确认后才带 true */
  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class AppResourceDto {
  @IsString()
  serverId!: string;

  @IsString()
  @MaxLength(2048)
  uri!: string;
}

export class AppModelContextDto {
  @IsString()
  serverId!: string;

  @IsString()
  conversationId!: string;

  @IsString()
  @MaxLength(256)
  toolCallId!: string;

  @IsString()
  @MaxLength(20000)
  text!: string;
}
