import { Body, Controller, Post } from '@nestjs/common';
import {
  PasskeyLoginOptionsDto,
  PasskeyLoginVerifyDto,
  PasskeyRegOptionsDto,
  PasskeyRegVerifyDto,
} from './dto/passkey.dto';
import { PasskeyService } from './passkey.service';

/** Passkey 公开端点（登录前调用，不挂 JwtAuthGuard）。rpId/origin 由前端按当前域名带上。 */
@Controller('auth/passkey')
export class PasskeyController {
  constructor(private readonly passkey: PasskeyService) {}

  @Post('register/options')
  registerOptions(@Body() dto: PasskeyRegOptionsDto) {
    return this.passkey.registrationOptions(dto.email, dto.rpId);
  }

  @Post('register/verify')
  registerVerify(@Body() dto: PasskeyRegVerifyDto) {
    return this.passkey.verifyRegistration(
      dto.email,
      dto.response,
      dto.rpId,
      dto.origin,
    );
  }

  @Post('login/options')
  loginOptions(@Body() dto: PasskeyLoginOptionsDto) {
    return this.passkey.authenticationOptions(dto.rpId);
  }

  @Post('login/verify')
  loginVerify(@Body() dto: PasskeyLoginVerifyDto) {
    return this.passkey.verifyAuthentication(
      dto.flowId,
      dto.response,
      dto.rpId,
      dto.origin,
    );
  }
}
