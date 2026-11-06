import { Module } from '@nestjs/common';
import { ToolRegistryModule } from '../agent/tool-registry.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { ModesController } from './modes.controller';
import { ModesService } from './modes.service';

/**
 * ModesModule — agent 模式的 CRUD / 目录 / 预览。SkillsModule、McpModule 是 @Global 的；
 * 工具注册表与 worker 共用同一实例（ToolRegistryModule）；沙箱偏好用于判断当前环境有无沙箱。
 */
@Module({
  imports: [ToolRegistryModule, SandboxModule],
  controllers: [ModesController],
  providers: [ModesService],
})
export class ModesModule {}
