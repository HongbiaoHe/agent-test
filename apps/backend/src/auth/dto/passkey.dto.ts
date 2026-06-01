import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * rpId/origin 由前端按当前访问域名带上（window.location），
 * 使 passkey 在 localhost 与隧道域名下都自动正确，无需改 env。缺省回退到后端 env。
 */
export class PasskeyRpDto {
  @IsOptional()
  @IsString()
  rpId?: string;

  @IsOptional()
  @IsString()
  origin?: string;
}

export class PasskeyRegOptionsDto extends PasskeyRpDto {
  @IsString()
  @IsNotEmpty()
  email!: string;
}

export class PasskeyRegVerifyDto extends PasskeyRpDto {
  @IsString()
  @IsNotEmpty()
  email!: string;

  // WebAuthn 注册响应（结构复杂，仅校验为对象，避免被 whitelist 剥除）
  @IsObject()
  response!: RegistrationResponseJSON;
}

export class PasskeyLoginOptionsDto extends PasskeyRpDto {
  // username-first：带上邮箱，后端据此下发 allowCredentials；缺省则回退 discoverable
  @IsOptional()
  @IsString()
  email?: string;
}

export class PasskeyLoginVerifyDto extends PasskeyRpDto {
  @IsString()
  @IsNotEmpty()
  flowId!: string;

  @IsObject()
  response!: AuthenticationResponseJSON;
}
