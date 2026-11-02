/**
 * 后台任务 REST API（前端任务卡片用）。
 *   GET  /conversations/:id/background-tasks  → 该会话的全部后台任务（刷新后重建卡片状态）
 *   POST /background-tasks/:id/cancel          → 取消
 */
import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BackgroundService } from './background.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class BackgroundController {
  constructor(private readonly background: BackgroundService) {}

  @Get('conversations/:id/background-tasks')
  list(@CurrentUser() user: AuthUser, @Param('id') conversationId: string) {
    return this.background.listByConversation(user.userId, conversationId);
  }

  @Post('background-tasks/:id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.background.cancel(user.userId, id);
  }
}
