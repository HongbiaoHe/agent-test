import { ArgumentsHost, HttpStatus, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { BusinessException } from '../errors/business.exception';
import { ErrorCodes } from '../errors/error-code';

function mockHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status } as any;
  const req = { method: 'GET', url: '/x' } as any;
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('业务错误 → {code,message,data:null} + 对应 status', () => {
    const { host, status, json } = mockHost();
    filter.catch(new BusinessException(ErrorCodes.CONVERSATION_NOT_FOUND), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({
      code: ErrorCodes.CONVERSATION_NOT_FOUND.code,
      message: ErrorCodes.CONVERSATION_NOT_FOUND.message,
      data: null,
    });
  });

  it('普通 HttpException → 用 http status 当 code', () => {
    const { host, status, json } = mockHost();
    filter.catch(new BadRequestException('bad'), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ code: 400, message: 'bad', data: null });
  });

  it('未预期异常 → INTERNAL_ERROR(50000) + 500', () => {
    const { host, status, json } = mockHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      code: ErrorCodes.INTERNAL_ERROR.code,
      message: ErrorCodes.INTERNAL_ERROR.message,
      data: null,
    });
  });
});
