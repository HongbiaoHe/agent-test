import { IsObject } from 'class-validator';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { PasskeyRpDto } from '../../auth/dto/passkey.dto';

/** 登录态添加 passkey 第一步入参：仅 rpId/origin（继承），身份取自 JWT。 */
export class MyPasskeyOptionsDto extends PasskeyRpDto {}

/** 登录态添加 passkey 第二步入参：WebAuthn 注册响应。 */
export class MyPasskeyVerifyDto extends PasskeyRpDto {
  @IsObject()
  response!: RegistrationResponseJSON;
}
