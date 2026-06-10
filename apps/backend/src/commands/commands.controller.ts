import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SkillsService } from '../skills/skills.service';

/**
 * 供前端 `/` 自动补全拉取可用命令清单。
 * 数据源已切换为 SkillsService（内置 + 用户已安装且 enabled 的技能合并后过滤）。
 */
@Controller('commands')
@UseGuards(JwtAuthGuard)
export class CommandsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const defs = await this.skills.listFor(user.userId);
    return defs
      .filter((d) => d.enabled)
      .map(({ name, description, domain }) => ({ name, description, domain }));
  }
}
