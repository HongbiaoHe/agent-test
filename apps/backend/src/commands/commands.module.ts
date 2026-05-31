import { Global, Module } from '@nestjs/common';
import { CommandRegistryService } from './command-registry.service';
import { CommandsController } from './commands.controller';

/** 命令/技能注册表，全局可用（conversations 校验、worker 注入、controller 列表共用）。 */
@Global()
@Module({
  controllers: [CommandsController],
  providers: [CommandRegistryService],
  exports: [CommandRegistryService],
})
export class CommandsModule {}
