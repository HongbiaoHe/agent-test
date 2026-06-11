import { Module } from '@nestjs/common';
import { SandboxController } from './sandbox.controller';
import { SandboxStatusService } from './sandbox.service';

/** 沙箱状态模块：user 级只读查询（状态/配置/工作区文件），不创建不唤醒。 */
@Module({
  controllers: [SandboxController],
  providers: [SandboxStatusService],
})
export class SandboxModule {}
