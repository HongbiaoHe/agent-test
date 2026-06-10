import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

/** 成功响应统一包装成 { code: 0, message: 'ok', data }。 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T> | StreamableFile>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | StreamableFile> {
    return next.handle().pipe(
      map((data) =>
        // 二进制流式响应（媒体资产下载）原样透传，不裹 JSON envelope（设计 Issue 10）
        data instanceof StreamableFile
          ? data
          : { code: 0, message: 'ok', data },
      ),
    );
  }
}
