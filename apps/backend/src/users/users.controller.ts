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
import { PasskeyService } from '../auth/passkey.service';
import { MyPasskeyOptionsDto, MyPasskeyVerifyDto } from './dto/my-passkey.dto';
import { UsersService } from './users.service';

/**
 * UsersController — 当前用户信息与 passkey 管理（全部登录态）。
 * 安全：身份一律取自 JWT（@CurrentUser），不接受客户端传 email/userId，
 * 避免登录用户把 passkey 挂到他人账户（公开注册接口走 auth/passkey.controller.ts）。
 */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly passkey: PasskeyService,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.users.getMe(user.userId);
  }

  @Post('me/passkeys/options')
  passkeyOptions(@Body() dto: MyPasskeyOptionsDto, @CurrentUser() user: AuthUser) {
    return this.passkey.registrationOptionsForUser(
      { id: user.userId, email: user.email },
      dto.rpId,
    );
  }

  @Post('me/passkeys/verify')
  passkeyVerify(@Body() dto: MyPasskeyVerifyDto, @CurrentUser() user: AuthUser) {
    return this.passkey.verifyRegistrationForUser(
      user.userId,
      dto.response,
      dto.rpId,
      dto.origin,
    );
  }

  @Delete('me/passkeys/:id')
  deletePasskey(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.users.deletePasskey(user.userId, id);
  }
}
