import { Module } from '@nestjs/common';
import { SandboxController } from './sandbox.controller';
import { SandboxSettingsService } from './sandbox-settings.service';
import { SandboxStatusService } from './sandbox.service';

/**
 * 沙箱模块：user 级状态查询（不创建不唤醒）+ 提供方偏好。
 * 导出 SandboxSettingsService：worker / conversations 据此取该用户生效的提供方。
 */
@Module({
  controllers: [SandboxController],
  providers: [SandboxStatusService, SandboxSettingsService],
  exports: [SandboxSettingsService],
})
export class SandboxModule {}
