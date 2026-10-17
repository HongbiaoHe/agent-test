import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { SandboxModule } from '../sandbox/sandbox.module';
import { PreviewController } from './preview.controller';
import { previewBase, sharesSiteWithMain } from './preview-host';
import { PreviewProxy } from './preview-proxy';
import { PreviewSessionService } from './preview-session.service';

/**
 * 沙箱端口预览：签发预览地址（PreviewController）+ 子域名反代（PreviewProxy，main.ts 挂载）。
 * 导出 PreviewProxy 供 main.ts 在 Nest 中间件之前注册 HTTP 与 upgrade 处理。
 */
@Module({
  imports: [SandboxModule],
  controllers: [PreviewController],
  providers: [PreviewSessionService, PreviewProxy],
  exports: [PreviewProxy],
})
export class PreviewModule implements OnModuleInit {
  /** 部署配置检查：预览域名与主站同站时，预览页能碰到主站的父域 cookie（见 sharesSiteWithMain）。 */
  onModuleInit() {
    const base = previewBase();
    if (sharesSiteWithMain(base, process.env.CORS_ORIGIN)) {
      new Logger(PreviewModule.name).warn(
        `PREVIEW_PROXY_BASE（${base.host}）与主站（${process.env.CORS_ORIGIN}）在同一个可注册域名下：` +
          '预览页是 agent 写的任意代码，能读写主站设在父域上的 cookie。请改用独立的域名。',
      );
    }
  }
}
