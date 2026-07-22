import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasskeyController } from './passkey.controller';
import { PasskeyService } from './passkey.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('AUTH_JWT_SECRET');
        if (!secret) {
          throw new Error('AUTH_JWT_SECRET environment variable is not set');
        }
        return {
          secret,
          signOptions: { expiresIn: '7d' },
        };
      },
    }),
  ],
  controllers: [AuthController, PasskeyController],
  providers: [AuthService, PasskeyService, JwtAuthGuard],
  exports: [JwtAuthGuard, JwtModule, PasskeyService],
})
export class AuthModule {}
