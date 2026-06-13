import { HttpStatus, Injectable } from '@nestjs/common';
import { resolveProviderName } from '../auth/aaguid-map';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';

/** 当前用户只读信息 + passkey 管理。所有方法以 JWT 的 userId 为唯一身份来源。 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true, authenticators: true },
    });
    if (!user) {
      throw new BusinessException(ErrorCodes.INTERNAL_ERROR, HttpStatus.NOT_FOUND);
    }
    return {
      email: user.email,
      createdAt: user.createdAt,
      tenantName: user.tenant.name,
      // 只回展示所需字段，不泄漏 publicKey/counter/credentialId
      passkeys: user.authenticators.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        transports: a.transports,
        // aaguid 仅用于解析来源名，不直接外泄
        providerName: resolveProviderName(a.aaguid, a.deviceType),
        deviceType: a.deviceType,
        backedUp: a.backedUp,
        lastUsedAt: a.lastUsedAt,
      })),
    };
  }

  /** 删除本人 passkey。按 (id, userId) 查行防越权；允许删到 0（邮箱登录兜底）。 */
  async deletePasskey(userId: string, id: string) {
    const row = await this.prisma.authenticator.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new BusinessException(ErrorCodes.PASSKEY_NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    await this.prisma.authenticator.delete({ where: { id: row.id } });
    return { deleted: row.id };
  }
}
