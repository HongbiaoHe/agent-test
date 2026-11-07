import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AbortModule } from '../agent/abort.module';
import { checkpointerProvider } from '../agent/checkpointer.provider';
// 工具注册表（按模式装配 agent 的工具来源），与 ModesModule 共享同一实例
import { ToolRegistryModule } from '../agent/tool-registry.module';
import { EventsModule } from '../events/events.module';
// 有意的模块依赖：worker 是 media 工具的注入点，耦合收敛在此，agent.factory 不感知 media 模块
import { MediaModule } from '../media/media.module';
// 读用户改写的平台片段（ModesService.fragmentOverrides），与设置页预览同一来源
import { ModesModule } from '../modes/modes.module';
import { AgentProcessor } from './agent.processor';
import { SandboxModule } from '../sandbox/sandbox.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'agent-run' }),
    EventsModule,
    MediaModule,
    AbortModule,
    SandboxModule,
    ToolRegistryModule,
    ModesModule,
  ],
  providers: [AgentProcessor, checkpointerProvider],
})
export class WorkerModule {}
