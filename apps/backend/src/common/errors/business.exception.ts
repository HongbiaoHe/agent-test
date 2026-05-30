import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorDef } from './error-code';

/**
 * 业务异常：携带集中定义的 code + message。
 * 由 AllExceptionsFilter 统一转成 { code, message, data: null }。
 */
export class BusinessException extends HttpException {
  readonly errCode: number;

  constructor(err: ErrorDef, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ code: err.code, message: err.message }, status);
    this.errCode = err.code;
  }
}
