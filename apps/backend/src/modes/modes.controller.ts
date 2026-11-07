import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  FragmentInputDto,
  GeneralModeInputDto,
  GeneralModePreviewDto,
  ModeInputDto,
} from './dto/mode.dto';
import { ModesService } from './modes.service';

/**
 * ModesController — agent 模式 REST API（/settings/modes）。
 *   GET    /modes          → 当前用户的模式列表
 *   GET    /modes/catalog  → 可勾选的工具 / MCP server / 技能、片段 id、通用提示词、当前环境能力
 *   POST   /modes          → 新建
 *   POST   /modes/preview  → 按当前环境预览最终系统提示与不可用清单（不落库）
 *   GET    /modes/general  → 通用模式设置（生效提示词 / 是否自定义 / 默认提示词 / 默认模型与档位）
 *   PUT    /modes/general  → 整体替换通用模式设置（systemPrompt null = 恢复默认）
 *   POST   /modes/general/preview → 预览通用模式的最终系统提示
 *   GET    /modes/fragments → 平台片段列表（生效正文 / 默认正文 / 是否改写过）
 *   PUT    /modes/fragments/:fragmentId → 改写片段正文（text null 或与默认相同 = 恢复默认）
 *   PUT    /modes/:id      → 整体更新
 *   DELETE /modes/:id      → 删除（引用它的会话回到通用模式）
 */
@Controller('modes')
@UseGuards(JwtAuthGuard)
export class ModesController {
  constructor(private readonly modes: ModesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.modes.list(user.userId);
  }

  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) {
    return this.modes.catalog(user.userId);
  }

  @Post()
  create(@Body() dto: ModeInputDto, @CurrentUser() user: AuthUser) {
    return this.modes.create(user.userId, dto);
  }

  @Post('preview')
  preview(@Body() dto: ModeInputDto, @CurrentUser() user: AuthUser) {
    return this.modes.preview(user.userId, dto);
  }

  // /modes/general 系列必须在 /modes/:id 之前声明，否则 PUT /modes/general 会被 :id 吃掉
  @Get('general')
  getGeneral(@CurrentUser() user: AuthUser) {
    return this.modes.getGeneral(user.userId);
  }

  @Put('general')
  updateGeneral(
    @Body() dto: GeneralModeInputDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.modes.updateGeneral(user.userId, dto);
  }

  @Post('general/preview')
  previewGeneral(
    @Body() dto: GeneralModePreviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.modes.previewGeneral(user.userId, dto);
  }

  // /modes/fragments 系列同理，必须在 /modes/:id 之前声明
  @Get('fragments')
  listFragments(@CurrentUser() user: AuthUser) {
    return this.modes.listFragments(user.userId);
  }

  @Put('fragments/:fragmentId')
  updateFragment(
    @Param('fragmentId') fragmentId: string,
    @Body() dto: FragmentInputDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.modes.updateFragment(user.userId, fragmentId, dto);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: ModeInputDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.modes.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.modes.remove(user.userId, id);
  }
}
