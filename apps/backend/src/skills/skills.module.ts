/**
 * SkillsModule — @Global()，与 CommandsModule 保持一致：
 * SkillsService 全局可注入（ConversationsService、worker 等无需在各自 module imports 里添加）。
 * skillsStoreProvider（SKILLS_STORE）同样全局导出，worker 经 @Inject(SKILLS_STORE) 取得进程级
 * InMemoryStore 单例，用于 run 前 diff 播种技能文件。
 */

import { Global, Module } from '@nestjs/common';
import { SkillsController } from './skills.controller';
import { skillsStoreProvider } from './skill-store.provider';
import { SkillsService } from './skills.service';

@Global()
@Module({
  controllers: [SkillsController],
  providers: [SkillsService, skillsStoreProvider],
  exports: [SkillsService, skillsStoreProvider],
})
export class SkillsModule {}
