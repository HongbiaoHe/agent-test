import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasskeyController } from './passkey.controller';
import { PasskeyService } from './passkey.service';

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.AUTH_JWT_SECRET ?? 'dev-secret-change-in-prod',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AuthController, PasskeyController],
  providers: [AuthService, PasskeyService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule, PasskeyService],
})
export class AuthModule {}
