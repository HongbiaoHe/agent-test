import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SandboxStatusService } from './sandbox.service';

/** 沙箱状态（user 级只读；沙箱按用户分配，与会话无关）。 */
@Controller('sandbox')
@UseGuards(JwtAuthGuard)
export class SandboxController {
  constructor(private readonly sandbox: SandboxStatusService) {}

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
}
