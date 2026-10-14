import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateSandboxSettingsDto } from './dto/update-sandbox-settings.dto';
import { SandboxSettingsService } from './sandbox-settings.service';
import { SandboxStatusService } from './sandbox.service';

/** 沙箱状态（user 级只读；沙箱按用户分配，与会话无关）。 */
@Controller('sandbox')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(
    private readonly sandbox: SandboxStatusService,
    private readonly settings: SandboxSettingsService,
  ) {}

  /** 沙箱设置：提供方（生效/偏好/默认/可选项）+ 生命周期（/settings/sandbox 用）。 */
  @Get('settings')
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settings.getSettings(user.userId);
  }

  /** 局部更新沙箱设置。切换提供方不迁移工作区文件；生命周期立即应用到现有沙箱。 */
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateSandboxSettingsDto,
  ) {
    return this.settings.update(user.userId, dto);
  }

  /** ?files=1 才连沙箱列工作区文件（会刷新 Daytona 活动事件，见 service 注释）。 */
  @Get('status')
  status(@CurrentUser() user: AuthUser, @Query('files') files?: string) {
    return this.sandbox.status(user.userId, files === '1');
  }

  /** 列出工作区某目录的直接子项（?path=<相对路径>，缺省=根）——树展开时按需调用。 */
  @Get('dir')
  listDir(@CurrentUser() user: AuthUser, @Query('path') path?: string) {
    return this.sandbox.listDir(user.userId, path ?? '');
  }

  /** 读取单个文件用于预览（?path=<相对路径>）——点击文件时按需调用。 */
  @Get('file')
  readFile(@CurrentUser() user: AuthUser, @Query('path') path: string) {
    return this.sandbox.readFile(user.userId, path);
  }

  /**
   * 文件原始字节（?path=<相对路径>&download=1）：视频/音频 <video>/<audio> 直接播放（支持 Range）、
   * 任意文件下载。passthrough 只设状态码与头，正文仍由 StreamableFile 返回（拦截器透传）。
   */
  @Get('file/raw')
  async readRawFile(
    @CurrentUser() user: AuthUser,
    @Query('path') path: string,
    @Query('download') download: string | undefined,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const r = await this.sandbox.readRaw(
      user.userId,
      path,
      range,
      download === '1',
    );
    res.status(r.status);
    res.set(r.headers);
    return new StreamableFile(r.body, { length: r.body.length });
  }

  /** 启动图形桌面（幂等），返回 noVNC iframe 地址——桌面 Dialog 打开时调用。 */
  @Post('desktop')
  startDesktop(@CurrentUser() user: AuthUser) {
    return this.sandbox.startDesktop(user.userId);
  }

  /** 停止图形桌面（收尾语义，静默容错）——桌面 Dialog 关闭时调用。 */
  @Delete('desktop')
  stopDesktop(@CurrentUser() user: AuthUser) {
    return this.sandbox.stopDesktop(user.userId);
  }
}
