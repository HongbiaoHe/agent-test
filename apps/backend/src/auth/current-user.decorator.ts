import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './jwt-auth.guard';

/** 从 req.user 取出 JwtAuthGuard 注入的当前用户。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser =>
    ctx.switchToHttp().getRequest().user,
);
