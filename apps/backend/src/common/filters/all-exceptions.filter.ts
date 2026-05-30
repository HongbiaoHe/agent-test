import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BusinessException } from '../errors/business.exception';
import { ErrorCodes } from '../errors/error-code';

/**
 * 全局异常归一化：
 * - BusinessException → 按其 code/message 返回，warn 日志
 * - 其他 HttpException（如 ValidationPipe）→ 用 http status 当 code，warn
 * - 未预期异常 → INTERNAL_ERROR(50000)，error 日志（含 stack），不泄漏内部细节
 * 统一响应体：{ code, message, data: null }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof BusinessException) {
      const body = exception.getResponse() as { code: number; message: string };
      this.logger.warn(
        `[业务错误] ${req.method} ${req.url} code=${body.code} msg=${body.message}`,
      );
      res
        .status(exception.getStatus())
        .json({ code: body.code, message: body.message, data: null });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const raw =
        typeof resp === 'string'
          ? resp
          : ((resp as { message?: string | string[] })?.message ??
            exception.message);
      const message = Array.isArray(raw) ? raw.join('; ') : raw;
      this.logger.warn(
        `[HTTP异常] ${req.method} ${req.url} status=${status} msg=${message}`,
      );
      res.status(status).json({ code: status, message, data: null });
      return;
    }

    const err = exception as Error;
    this.logger.error(
      `[系统错误] ${req.method} ${req.url} ${err?.message}`,
      err?.stack,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: ErrorCodes.INTERNAL_ERROR.code,
      message: ErrorCodes.INTERNAL_ERROR.message,
      data: null,
    });
  }
}
