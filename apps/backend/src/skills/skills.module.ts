/**
 * SkillsModule — @Global()，与 CommandsModule 保持一致：
 * SkillsService 全局可注入（ConversationsService、worker 等无需在各自 module imports 里添加）。
 */

import { Global, Module } from '@nestjs/common';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

@Global()
@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}
