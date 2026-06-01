import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Redis } from 'ioredis';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { AuthService } from './auth.service';

const RP_ID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME ?? 'Agent';
const ORIGIN = process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3100';
const CHALLENGE_TTL = 300; // 秒

function parseTransports(s: string | null): AuthenticatorTransportFuture[] {
  return (s?.split(',').filter(Boolean) ?? []) as AuthenticatorTransportFuture[];
}

/**
 * WebAuthn / Passkey：注册与登录全在后端完成（@simplewebauthn/server），
 * 凭据存现有 MySQL，验证通过由 AuthService 签发同一套后端 JWT。
 * 挑战值临时存 Redis（TTL）。登录走 discoverable credential，无需先填邮箱。
 */
@Injectable()
export class PasskeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** 注册第一步：按 email 找/建用户，产出注册 options，挑战存 Redis。 */
  async registrationOptions(email: string, rpId?: string) {
    const user = await this.auth.findOrCreateByEmail(email);
    const existing = await this.prisma.authenticator.findMany({
      where: { userId: user.id },
    });
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId || RP_ID,
      userName: email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((a) => ({
        id: a.credentialId,
        transports: parseTransports(a.transports),
      })),
      authenticatorSelection: {
        // platform：用本机平台认证器（Mac Touch ID / Windows Hello），注册直接走指纹而非给一堆选项
        authenticatorAttachment: 'platform',
        // required：登录走 discoverable（不填邮箱、无 allowCredentials），必须生成 resident key 才能被发现，否则登录报 NotAllowedError
        residentKey: 'required',
        userVerification: 'preferred',
      },
    });
    await this.redis.set(
      `webauthn:reg:${user.id}`,
      options.challenge,
      'EX',
      CHALLENGE_TTL,
    );
    return options;
  }

  /** 注册第二步：校验响应，存 Authenticator。 */
  async verifyRegistration(
    email: string,
    response: RegistrationResponseJSON,
    rpId?: string,
    origin?: string,
  ) {
    const user = await this.auth.findOrCreateByEmail(email);
    const expectedChallenge = await this.redis.get(`webauthn:reg:${user.id}`);
    if (!expectedChallenge) {
      throw new BusinessException(ErrorCodes.PASSKEY_CHALLENGE_EXPIRED);
    }
    let verified = false;
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin || ORIGIN,
        expectedRPID: rpId || RP_ID,
      });
      verified = result.verified;
      info = result.registrationInfo;
    } catch {
      throw new BusinessException(ErrorCodes.PASSKEY_VERIFY_FAILED);
    }
    if (!verified || !info) {
      throw new BusinessException(ErrorCodes.PASSKEY_VERIFY_FAILED);
    }
    await this.prisma.authenticator.create({
      data: {
        credentialId: info.credential.id,
        userId: user.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: (response.response.transports ?? []).join(',') || null,
      },
    });
    await this.redis.del(`webauthn:reg:${user.id}`);
    // 注册成功即登录：直接签发后端 JWT，前端一步进入
    const token = await this.auth.signToken(user);
    return { verified: true, token, email: user.email };
  }

  /**
   * 登录第一步：产出认证 options，挑战存 Redis 并返回 flowId。
   * 传 email 则走 username-first：按邮箱取该用户凭证下发 allowCredentials，浏览器据此精确定位
   * （不依赖凭证是否 resident，localhost 下也稳）。不传则回退 discoverable。
   */
  async authenticationOptions(rpId?: string, email?: string) {
    let allowCredentials:
      | { id: string; transports: AuthenticatorTransportFuture[] }[]
      | undefined;
    if (email) {
      const user = await this.prisma.user.findUnique({ where: { email } });
      if (user) {
        const creds = await this.prisma.authenticator.findMany({
          where: { userId: user.id },
        });
        allowCredentials = creds.map((c) => ({
          id: c.credentialId,
          transports: parseTransports(c.transports),
        }));
      }
    }
    const options = await generateAuthenticationOptions({
      rpID: rpId || RP_ID,
      userVerification: 'preferred',
      ...(allowCredentials ? { allowCredentials } : {}),
    });
    const flowId = randomUUID();
    await this.redis.set(
      `webauthn:auth:${flowId}`,
      options.challenge,
      'EX',
      CHALLENGE_TTL,
    );
    return { flowId, options };
  }

  /** 登录第二步：按 credentialId 找凭据→用户，校验断言，更新计数器，签发后端 JWT。 */
  async verifyAuthentication(
    flowId: string,
    response: AuthenticationResponseJSON,
    rpId?: string,
    origin?: string,
  ) {
    const expectedChallenge = await this.redis.get(`webauthn:auth:${flowId}`);
    if (!expectedChallenge) {
      throw new BusinessException(ErrorCodes.PASSKEY_CHALLENGE_EXPIRED);
    }
    const cred = await this.prisma.authenticator.findUnique({
      where: { credentialId: response.id },
    });
    if (!cred) throw new BusinessException(ErrorCodes.PASSKEY_NOT_FOUND);
    const user = await this.prisma.user.findUnique({ where: { id: cred.userId } });
    if (!user) throw new BusinessException(ErrorCodes.PASSKEY_NOT_FOUND);

    let verified = false;
    let newCounter = cred.counter;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin || ORIGIN,
        expectedRPID: rpId || RP_ID,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(cred.publicKey),
          counter: cred.counter,
          transports: parseTransports(cred.transports),
        },
      });
      verified = result.verified;
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      throw new BusinessException(ErrorCodes.PASSKEY_VERIFY_FAILED);
    }
    if (!verified) throw new BusinessException(ErrorCodes.PASSKEY_VERIFY_FAILED);

    await this.prisma.authenticator.update({
      where: { credentialId: cred.credentialId },
      data: { counter: newCounter },
    });
    await this.redis.del(`webauthn:auth:${flowId}`);
    const token = await this.auth.signToken(user);
    return { token, email: user.email };
  }
}
