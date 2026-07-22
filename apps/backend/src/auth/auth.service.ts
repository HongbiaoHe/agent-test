import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Redis } from 'ioredis';
import { Resend } from 'resend';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private getResendClient(): Resend {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey || apiKey === 're_xxxxxxxxx') {
      throw new BusinessException(ErrorCodes.RESEND_CONFIG_MISSING);
    }
    return new Resend(apiKey);
  }

  /** 发送登录注册验证码 */
  async sendVerificationCode(email: string): Promise<string | undefined> {
    const limitKey = `auth:code:limit:${email}`;
    const isLimited = await this.redis.get(limitKey);
    if (isLimited) {
      throw new BusinessException(ErrorCodes.VERIFY_CODE_TOO_FREQUENT);
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeKey = `auth:code:${email}`;

    await this.redis.set(codeKey, code, 'EX', 600); // 10分钟有效期
    await this.redis.set(limitKey, '1', 'EX', 60); // 60秒发送频率限制

    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey || apiKey === 're_xxxxxxxxx') {
      const logger = new Logger(AuthService.name);
      logger.warn(
        `RESEND_API_KEY is not configured or is the default placeholder. Returning validation code directly in response for local testing: ${code}`,
      );
      return code;
    }

    const resendClient = this.getResendClient();
    const fromEmail =
      this.config.get<string>('RESEND_FROM_EMAIL') ?? 'onboarding@resend.dev';

    try {
      await resendClient.emails.send({
        from: fromEmail,
        to: email,
        subject: '您的登录注册验证码',
        html: `<p>您好！您的验证码为 <strong>${code}</strong>，有效期为 10 分钟。如果不是您本人操作，请忽略此邮件。</p>`,
      });
      return undefined;
    } catch (error: unknown) {
      await this.redis.del(codeKey);
      await this.redis.del(limitKey);
      throw error;
    }
  }

  /** 验证验证码并登录 */
  async verifyCode(email: string, code: string): Promise<{ token: string }> {
    const codeKey = `auth:code:${email}`;
    const storedCode = await this.redis.get(codeKey);

    if (!storedCode) {
      throw new BusinessException(ErrorCodes.VERIFY_CODE_EXPIRED);
    }

    if (storedCode !== code) {
      throw new BusinessException(ErrorCodes.VERIFY_CODE_INVALID);
    }

    await this.redis.del(codeKey);
    await this.redis.del(`auth:code:limit:${email}`);

    const user = await this.findOrCreateByEmail(email);
    const token = await this.signToken(user);
    return { token };
  }

  /** email 不存在则自动建租户 + 用户（一 email 一租户，便于演示多租户隔离）。 */
  async findOrCreateByEmail(email: string) {
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      const tenant = await this.prisma.tenant.create({ data: { name: email } });
      user = await this.prisma.user.create({
        data: { email, tenantId: tenant.id },
      });
    }
    return user;
  }

  /** 签发后端标准 JWT（REST/socket 鉴权用）。 */
  signToken(user: {
    id: string;
    tenantId: string;
    email: string;
  }): Promise<string> {
    return this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
    });
  }

  /** 邮箱登录（开发态兜底；passkey 为主，见 PasskeyService）。 */
  async login(email: string): Promise<{ token: string }> {
    const user = await this.findOrCreateByEmail(email);
    return { token: await this.signToken(user) };
  }
}
