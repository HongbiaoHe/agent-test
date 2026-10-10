import { Module } from '@nestjs/common';
import { CanvasSkillsController } from './canvas-skills.controller';
import { CanvasSkillsService } from './canvas-skills.service';

/** 画布 agent 的技能库（内置 + 用户自建）。CanvasModule 引入它给 worker 与 save_skill 工具用。 */
@Module({
  controllers: [CanvasSkillsController],
  providers: [CanvasSkillsService],
  exports: [CanvasSkillsService],
})
export class CanvasSkillsModule {}
