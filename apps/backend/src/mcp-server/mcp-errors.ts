import { Logger } from '@nestjs/common';
import { BusinessException } from '../common/errors/business.exception';
import { SafeFetchError } from './safe-fetch';

const logger = new Logger('McpServer');

/** 给第三方 agent 看的内部错误说法：不带堆栈、文件路径、SQL 之类的服务端细节 */
export const INTERNAL_ERROR_MESSAGE = '服务端内部错误，请稍后重试';

/**
 * 业务拒绝（BusinessException / SafeFetchError 的文案本就是对外的）原样放行；
 * 其它异常（Prisma、运行时错误……）记日志后换成一句通用说法——它们的 message 会带出
 * 服务端源码位置与表结构，不能回给第三方。
 */
export function toPublicError(e: unknown): Error {
  if (e instanceof BusinessException || e instanceof SafeFetchError) {
    return e;
  }
  logger.error(
    `MCP 工具内部错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  return new Error(INTERNAL_ERROR_MESSAGE);
}
