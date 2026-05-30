import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthUser {
  userId: string;
  tenantId: string;
  email: string;
}

/** 验证 Authorization: Bearer <jwt>，解出 userId/tenantId 注入 req.user。 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = req.headers?.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少 token');
    }
    try {
      const p = await this.jwt.verifyAsync(header.slice(7));
      req.user = {
        userId: p.sub,
        tenantId: p.tenantId,
        email: p.email,
      } as AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException('token 无效或已过期');
    }
  }
}
