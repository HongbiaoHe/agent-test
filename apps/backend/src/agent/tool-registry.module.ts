import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { TOOL_REGISTRY, toolRegistryProvider } from './tool-registry.provider';

/**
 * 工具注册表装配：WorkerModule（按模式装配 agent）与 ModesModule（目录 / 预览）共享同一实例
 * （Nest 模块实例缓存保证跨 importer 拿到同一 provider）。BackgroundModule 是 @Global 的，不用再 import。
 */
@Module({
  imports: [MediaModule],
  providers: [toolRegistryProvider],
  exports: [TOOL_REGISTRY],
})
export class ToolRegistryModule {}
