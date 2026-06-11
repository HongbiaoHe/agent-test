import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  // 散逸 promise 兜底：第三方库的后台 promise reject（无人 await）时，Node 22 默认
  // 直接杀进程。实测案例：停止运行（AbortSignal）中断 LLM 流式后，@google/generative-ai
  // 的内部聚合 response promise 以 "Error reading from the stream" reject——没有这层
  // 兜底，一次停止就让整个后端死掉。只记日志不退出；业务错误各自的 catch 不受影响。
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[unhandledRejection] ${msg}`);
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3100',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.listen(process.env.PORT ?? 3101);
}
bootstrap();
