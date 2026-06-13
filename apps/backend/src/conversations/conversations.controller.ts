import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationsService } from './conversations.service';
import { AppendMessageDto } from './dto/append-message.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  create(@Body() dto: CreateConversationDto, @CurrentUser() user: AuthUser) {
    return this.conversations.create(
      dto.goal,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.conversations.list(user.tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.conversations.findOne(id, user.tenantId);
  }

  /** 主动停止当前运行（幂等；返回 { stopped } 表示本次是否实际停掉了什么）。 */
  @Post(':id/stop')
  stop(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.conversations.stop(id, user.tenantId);
  }

  @Post(':id/messages')
  append(
    @Param('id') id: string,
    @Body() dto: AppendMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.conversations.appendMessage(
      id,
      dto.content,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }

  /**
   * 文件接口路由设计说明：
   * - GET /conversations/:id/files          → 列出沙箱工作目录下的产物文件
   * - GET /conversations/:id/files/download → 下载单个文件（?path=<相对路径>）
   *
   * 为什么 download 独立为子路由而非 /files?path= 分支：
   * 列表与下载混用同一路由时，controller 需要按查询参数分叉，违反单一职责；
   * 独立路由语义更清晰，也便于独立加速率限制或鉴权策略。
   */

  /** 列出会话沙箱工作目录的产物文件（排除 node_modules / 隐藏文件 / skills 目录）。 */
  @Get(':id/files')
  listFiles(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.conversations.listFiles(id, user.tenantId);
  }

  /** 下载会话沙箱中的单个产物文件，以 base64 编码返回。 */
  @Get(':id/files/download')
  downloadFile(
    @Param('id') id: string,
    @Query('path') relPath: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.conversations.downloadFile(id, user.tenantId, relPath);
  }
}
