import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SandboxStatusService } from './sandbox.service';

/** 沙箱状态（user 级只读；沙箱按用户分配，与会话无关）。 */
@Controller('sandbox')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(private readonly sandbox: SandboxStatusService) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.sandbox.status(user.userId);
  }
}
