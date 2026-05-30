import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 简化登录（开发期，passkey/WebAuthn 留设计文档 §4.1 后续）：
   * email 不存在则自动建租户 + 用户（一 email 一租户，便于演示多租户隔离）。
   */
  async login(email: string): Promise<{ token: string }> {
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      const tenant = await this.prisma.tenant.create({ data: { name: email } });
      user = await this.prisma.user.create({
        data: { email, tenantId: tenant.id },
      });
    }
    const token = await this.jwt.signAsync({
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email,
    });
    return { token };
  }
}
