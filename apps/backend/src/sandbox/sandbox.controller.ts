import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SandboxStatusService } from './sandbox.service';

/** 沙箱状态（user 级只读；沙箱按用户分配，与会话无关）。 */
@Controller('sandbox')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(private readonly sandbox: SandboxStatusService) {}

  /** ?files=1 才连沙箱列工作区文件（会刷新 Daytona 活动事件，见 service 注释）。 */
  @Get('status')
  status(@CurrentUser() user: AuthUser, @Query('files') files?: string) {
    return this.sandbox.status(user.userId, files === '1');
  }
}
