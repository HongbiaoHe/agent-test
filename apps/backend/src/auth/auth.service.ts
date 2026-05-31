import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

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
