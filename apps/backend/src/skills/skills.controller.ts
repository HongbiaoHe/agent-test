/**
 * SkillsController — 技能管理 REST API。
 *
 * 路由职责：
 *   GET    /skills         → 列出用户所有技能（含 disabled，供管理页）
 *   POST   /skills/install → 从 GitHub 安装技能，幂等（upsert）
 *   PATCH  /skills/:name   → 启用 / 禁用已安装技能
 *   DELETE /skills/:name   → 删除已安装技能（磁盘 + DB）
 *
 * 安全注意事项：
 * - DELETE 先按 DB 行查出 name，再用 DB 行的 name 构建路径，
 *   避免直接用 URL 参数拼路径造成目录遍历。
 * - 内置技能（source='builtin'）没有 DB 行，PATCH/DELETE 会因 findUnique 返回 null
 *   而抛 SKILL_NOT_FOUND，天然防止误改内置技能。
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCodes } from '../common/errors/error-code';
import { PrismaService } from '../prisma/prisma.service';
import { installSkillFromGithub } from './skill-installer';
import { InstallSkillDto } from './dto/install-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import { SkillsService } from './skills.service';

/** 惰性求值：与 skills.service.ts 保持一致，避免模块加载时快照 env 旧值。 */
const dataDir = () =>
  process.env.SKILLS_DATA_DIR ?? join(process.cwd(), 'data', 'skills');

@Controller('skills')
@UseGuards(JwtAuthGuard)
export class SkillsController {
  constructor(
    private readonly skills: SkillsService,
    private readonly prisma: PrismaService,
  ) {}

  /** 列出用户有效技能（含 disabled 安装技能，供管理页展示并重新启用）。 */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.skills.listFor(user.userId);
  }

  /** 技能详情（含文件路径列表与 SKILL.md 原文）。listFor 同语义：disabled 也可查看。 */
  @Get(':name')
  async detail(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    const def = await this.skills.detailFor(user.userId, name);
    if (!def) {
      throw new BusinessException(ErrorCodes.SKILL_NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    return def;
  }

  /**
   * 从 GitHub 安装技能。
   * 幂等：重复安装同一技能时 upsert 更新元数据并重新 enabled=true。
   */
  @Post('install')
  async install(
    @Body() dto: InstallSkillDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { userId } = user;
    const destRoot = join(dataDir(), userId);

    const installed = await installSkillFromGithub({
      repo: dto.repo,
      path: dto.path,
      ref: dto.ref,
      destRoot,
    });

    // 落 DB：幂等 upsert，重装时刷新元数据并重新启用
    const row = await this.prisma.skill.upsert({
      where: { userId_name: { userId, name: installed.name } },
      create: {
        userId,
        name: installed.name,
        description: installed.description,
        source: installed.source,
        enabled: true,
      },
      update: {
        description: installed.description,
        source: installed.source,
        enabled: true,
      },
    });

    // 只回前端列表同款字段（SkillInfo 形状），不泄漏 userId 等内部列
    return {
      name: row.name,
      description: row.description,
      kind: 'github' as const, // install 只来自 GitHub
      source: row.source,
      enabled: row.enabled,
    };
  }

  /**
   * 启用 / 禁用已安装技能。
   * 内置技能没有 DB 行，findUnique 返回 null → SKILL_NOT_FOUND。
   */
  @Patch(':name')
  async update(
    @Param('name') name: string,
    @Body() dto: UpdateSkillDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { userId } = user;

    const row = await this.prisma.skill.findUnique({
      where: { userId_name: { userId, name } },
    });
    if (!row) {
      throw new BusinessException(ErrorCodes.SKILL_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    return this.prisma.skill.update({
      where: { userId_name: { userId, name } },
      data: { enabled: dto.enabled },
    });
  }

  /**
   * 删除已安装技能（磁盘 + DB）。
   * 路径由 DB 行的 name 构建，而非原始 URL 参数，防止路径遍历。
   */
  @Delete(':name')
  async remove(
    @Param('name') name: string,
    @CurrentUser() user: AuthUser,
  ) {
    const { userId } = user;

    // 先校验 DB 行存在（同时作为路径遍历防护：只删 DB 里登记的技能）
    const row = await this.prisma.skill.findUnique({
      where: { userId_name: { userId, name } },
    });
    if (!row) {
      throw new BusinessException(ErrorCodes.SKILL_NOT_FOUND, HttpStatus.NOT_FOUND);
    }

    // 用 DB 行的 name 构建路径，不使用 URL 参数
    const skillDir = join(dataDir(), userId, row.name);
    rmSync(skillDir, { recursive: true, force: true });

    await this.prisma.skill.delete({
      where: { userId_name: { userId, name: row.name } },
    });

    return { deleted: row.name };
  }
}
