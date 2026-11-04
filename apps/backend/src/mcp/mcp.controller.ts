/**
 * MCP 连接器 REST API。
 *
 *   GET    /mcp/servers                 → 已添加的连接器 + 还没添加的推荐连接器
 *   POST   /mcp/servers                 → 添加自定义连接器（随即探测连接；401 → 返回授权 URL）
 *   POST   /mcp/presets/:key            → 连接推荐连接器
 *   GET    /mcp/servers/:id             → 单个连接器（详情页）
 *   PATCH  /mcp/servers/:id             → 启停 / 改工具权限
 *   POST   /mcp/servers/:id/connect     → 重新连接（刷新工具快照；授权失效时返回授权 URL）
 *   POST   /mcp/servers/:id/disconnect  → 断开（清 token）
 *   DELETE /mcp/servers/:id             → 删除
 *
 *   App（iframe 卡片）经宿主代理的请求：
 *   POST   /mcp/apps/resource           → 取 UI 资源 HTML + sandbox 源
 *   POST   /mcp/apps/read-resource      → resources/read
 *   POST   /mcp/apps/call-tool          → tools/call（权限 / 审批规则见 McpService.callToolFromApp）
 *   POST   /mcp/apps/model-context      → ui/update-model-context
 *
 *   GET    /mcp/oauth/callback          → OAuth 回调（无需登录：state 绑定了用户），见 McpOAuthController
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import {
  AppCallToolDto,
  AppModelContextDto,
  AppResourceDto,
  CreateMcpServerDto,
  UpdateMcpServerDto,
} from './dto/mcp.dto';
import { McpAuthRequiredError, McpService } from './mcp.service';

/** App 侧请求的错误映射：授权失效给专门的错误码，前端据此提示重新连接。 */
async function appRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof McpAuthRequiredError) {
      throw new BusinessException(ErrorCodes.MCP_AUTH_REQUIRED);
    }
    throw e;
  }
}

@Controller('mcp')
@UseGuards(JwtAuthGuard)
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get('servers')
  list(@CurrentUser() user: AuthUser) {
    return this.mcp.list(user.userId);
  }

  @Post('servers')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMcpServerDto) {
    return this.mcp.create(user.userId, dto);
  }

  @Post('presets/:key')
  addPreset(@CurrentUser() user: AuthUser, @Param('key') key: string) {
    return this.mcp.addPreset(user.userId, key);
  }

  @Get('servers/:id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.mcp.get(user.userId, id);
  }

  @Patch('servers/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateMcpServerDto,
  ) {
    return this.mcp.update(user.userId, id, dto);
  }

  @Post('servers/:id/connect')
  connect(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.mcp.connect(user.userId, id);
  }

  @Post('servers/:id/disconnect')
  disconnect(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.mcp.disconnect(user.userId, id);
  }

  @Delete('servers/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.mcp.remove(user.userId, id);
  }

  @Post('apps/resource')
  appResource(@CurrentUser() user: AuthUser, @Body() dto: AppResourceDto) {
    return appRequest(() =>
      this.mcp.appResource(user.userId, dto.serverId, dto.uri),
    );
  }

  @Post('apps/read-resource')
  readResource(@CurrentUser() user: AuthUser, @Body() dto: AppResourceDto) {
    return appRequest(() =>
      this.mcp.readResource(user.userId, dto.serverId, dto.uri),
    );
  }

  /**
   * server 自己报的执行失败（网络 / 协议错误）以 isError 结果回给 App，而不是 HTTP 错误：
   * 这样 App 能按 MCP 语义处理；权限 / 审批 / 授权类错误仍走业务错误码。
   */
  @Post('apps/call-tool')
  async callTool(
    @CurrentUser() user: AuthUser,
    @Body() dto: AppCallToolDto,
  ): Promise<CallToolResult> {
    try {
      return await appRequest(() =>
        this.mcp.callToolFromApp(
          user.userId,
          dto.serverId,
          dto.name,
          dto.arguments ?? {},
          dto.confirmed === true,
        ),
      );
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      return {
        isError: true,
        content: [
          { type: 'text', text: e instanceof Error ? e.message : String(e) },
        ],
      };
    }
  }

  @Post('apps/model-context')
  async modelContext(
    @CurrentUser() user: AuthUser,
    @Body() dto: AppModelContextDto,
  ) {
    const server = await this.mcp.get(user.userId, dto.serverId);
    return this.mcp.setAppContext(
      user.userId,
      dto.conversationId,
      dto.toolCallId,
      server.name,
      dto.text,
    );
  }
}

/**
 * OAuth 回调页（弹窗里打开，设计 Q8）：换完 token 后通知主站页面（见 callbackHtml），再自关。
 * 不挂 JwtAuthGuard——授权服务器把浏览器重定向回来时不带我们的登录态，用户归属由 state 决定。
 */
@Controller('mcp/oauth')
export class McpOAuthController {
  constructor(private readonly mcp: McpService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let payload: OAuthCallbackPayload;
    if (error || !code || !state) {
      payload = {
        type: 'mcp-oauth',
        ok: false,
        error: errorDescription || error || 'Missing authorization code',
      };
    } else {
      try {
        const { server } = await this.mcp.completeOAuth(code, state);
        payload = {
          type: 'mcp-oauth',
          ok: server.status === 'connected',
          serverId: server.id,
        };
      } catch (e) {
        payload = {
          type: 'mcp-oauth',
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    res
      .status(HttpStatus.OK)
      .type('html')
      .setHeader('Cache-Control', 'no-store')
      .send(callbackHtml(payload));
  }
}

/**
 * 回调页经 /api-backend 反代，与主站同源：用 BroadcastChannel 通知主站页面，而不是 window.opener ——
 * 授权页若设了 COOP，弹窗与主站的 opener 关系会被切断，postMessage 送不到。
 * 弹窗里：通知完自关。整页跳转来的（弹窗被拦截的兜底，前端在本标签页 sessionStorage 打了
 * mcp-oauth-redirect 标记）：不能关——那是用户的主标签页，跳回设置页。关不掉的窗口同样跳回。
 */
function callbackHtml(payload: OAuthCallbackPayload): string {
  // JSON 进 <script> 前转义 <，防 error 文本里带 </script> 截断脚本
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  const delay = payload.ok ? 300 : 2500;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title>
<style>body{font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><p>${payload.ok ? 'Connected. You can close this window.' : 'Connection failed. You can close this window and try again.'}</p>
<script>
(function(){
  var data = ${data};
  try { var ch = new BroadcastChannel('mcp-oauth'); ch.postMessage(data); ch.close(); } catch (e) {}
  var redirected = false;
  try { redirected = sessionStorage.getItem('mcp-oauth-redirect') === '1'; sessionStorage.removeItem('mcp-oauth-redirect'); } catch (e) {}
  var back = function(){ location.replace('/settings/mcp'); };
  setTimeout(function(){
    if (redirected) return back();
    window.close();
    setTimeout(back, 300);
  }, ${delay});
})();
</script></body></html>`;
}

interface OAuthCallbackPayload {
  type: 'mcp-oauth';
  ok: boolean;
  serverId?: string;
  error?: string;
}
