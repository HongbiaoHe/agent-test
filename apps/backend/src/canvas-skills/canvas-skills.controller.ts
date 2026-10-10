import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CanvasSkillsService } from './canvas-skills.service';
import { SetCanvasSkillEnabledDto } from './dto/set-enabled.dto';

/**
 * 画布技能管理。前缀刻意不放在 /canvas 下：CanvasController 有 GET /canvas/:id，
 * /canvas/skills 会被它当成会话 id 吃掉。
 * 新建/修改只走 agent 的 save_skill（skills-creator 引导写出规范的 SKILL.md），这里不开写入口。
 */
@Controller('canvas-skills')
@UseGuards(JwtAuthGuard)
export class CanvasSkillsController {
  constructor(private readonly skills: CanvasSkillsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.skills.listFor(user.userId);
  }

  @Get(':name')
  detail(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    return this.skills.detailFor(user.userId, name);
  }

  @Patch(':name')
  setEnabled(
    @Param('name') name: string,
    @Body() dto: SetCanvasSkillEnabledDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.skills.setEnabled(user.userId, name, dto.enabled);
  }

  @Delete(':name')
  remove(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    return this.skills.remove(user.userId, name);
  }
}
