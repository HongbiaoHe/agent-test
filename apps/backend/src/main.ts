import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { pinEnvProxyDispatcher } from './common/env-proxy-dispatcher';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { PreviewProxy } from './preview/preview-proxy';

async function bootstrap() {
  // 必须最先执行：E2B SDK 首次请求会加载 undici v8，若此时还没登记，原生 fetch（Gemini 等）
  // 会被它改成不走代理的直连而全部超时（见 env-proxy-dispatcher.ts）
  pinEnvProxyDispatcher();

  // 散逸 promise 兜底：第三方库的后台 promise reject（无人 await）时，Node 22 默认
  // 直接杀进程。实测案例：停止运行（AbortSignal）中断 LLM 流式后，@google/generative-ai
  // 的内部聚合 response promise 以 "Error reading from the stream" reject——没有这层
  // 兜底，一次停止就让整个后端死掉。只记日志不退出；业务错误各自的 catch 不受影响。
  process.on('unhandledRejection', (reason) => {
    const msg =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
    console.error(`[unhandledRejection] ${msg}`);
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // 端口预览反代必须排在最前：p-<id>.<基域名> 的请求是另一个源（用户沙箱里的应用），
  // 不能被 CORS / 日志 / 鉴权 / 响应包装处理；其余请求直接 next() 放行（见 PreviewProxy）
  const preview = app.get(PreviewProxy);
  app.use(preview.http);
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3100',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();
  // WebSocket 升级分流：预览主机交给反代（vite HMR 等），其余原样交给已注册的监听者（socket.io）。
  // 必须接管而不是并排监听：engine.io 对它不认识的升级请求会在 1s 内无写出时直接关掉 socket，
  // 而反代连上游（TLS 到提供方）可能超过 1s。init 之后 socket.io 已挂好监听，此时接管。
  const server = app.getHttpServer();
  const others = server.listeners('upgrade');
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    if (preview.upgrade(req, socket, head)) return;
    for (const l of others) l.call(server, req, socket, head);
  });
  await app.listen(process.env.PORT ?? 3101);
}
bootstrap();
