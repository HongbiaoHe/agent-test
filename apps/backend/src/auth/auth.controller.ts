import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto): Promise<{ token: string }> {
    return await this.auth.verifyCode(dto.email, dto.code);
  }

  @Post('send-code')
  async sendCode(
    @Body() dto: SendCodeDto,
  ): Promise<{ success: boolean; message: string; code?: string }> {
    const code = await this.auth.sendVerificationCode(dto.email);
    if (code) {
      return {
        success: true,
        message: 'Verification code returned directly (testing environment)',
        code,
      };
    }
    return { success: true, message: 'Verification code sent successfully' };
  }

  @Post('verify-code')
  async verifyCode(@Body() dto: VerifyCodeDto): Promise<{ token: string }> {
    return await this.auth.verifyCode(dto.email, dto.code);
  }
}
