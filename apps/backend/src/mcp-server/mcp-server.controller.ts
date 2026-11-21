import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePatDto } from './dto/create-pat.dto';
import { McpGrantService } from './mcp-grant.service';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { MCP_SCOPES, mcpResourceUrl } from './mcp-server.config';

/**
 * 画布 MCP 对外服务的站内接口（登录态 JWT）：同意页的取详情 / 允许 / 拒绝，
 * 设置页的服务信息、PAT 创建、已授权应用列表与吊销。协议端点（/mcp、/oauth/*）不在这里，见 mcp-server.http.ts。
 */
@Controller('mcp-server')
@UseGuards(JwtAuthGuard)
export class McpServerController {
  constructor(
    private readonly grants: McpGrantService,
    private readonly oauth: McpOAuthProvider,
  ) {}

  /** 设置页拼配置片段用 */
  @Get('info')
  info() {
    return { mcpUrl: mcpResourceUrl().href, scopes: MCP_SCOPES };
  }

  @Get('consent/:requestId')
  consent(@Param('requestId') requestId: string) {
    return this.oauth.consentDetails(requestId);
  }

  @Post('consent/:requestId/approve')
  approve(
    @Param('requestId') requestId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.oauth.approve(requestId, user);
  }

  @Post('consent/:requestId/deny')
  deny(@Param('requestId') requestId: string) {
    return this.oauth.deny(requestId);
  }

  @Get('grants')
  list(@CurrentUser() user: AuthUser) {
    return this.grants.list(user.userId);
  }

  /** 新建 PAT：令牌明文只在这次响应里出现 */
  @Post('grants')
  createPat(@Body() dto: CreatePatDto, @CurrentUser() user: AuthUser) {
    return this.grants.createPat(
      user,
      dto.name,
      dto.scopes,
      dto.expiresInDays ?? null,
    );
  }

  @Delete('grants/:id')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.grants.revoke(user.userId, id);
  }
}
