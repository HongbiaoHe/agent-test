import { Module } from '@nestjs/common';
import { CommandsController } from './commands.controller';

/**
 * CommandsModule：仅保留 REST controller（/commands 补全接口）。
 * 技能注册表已迁移到 SkillsModule（@Global），CommandsController 直接注入全局的 SkillsService。
 */
@Module({
  controllers: [CommandsController],
})
export class CommandsModule {}
