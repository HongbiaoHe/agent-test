import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { canvasOpSchema } from './canvas.op-schema';
import { CanvasService } from './canvas.service';
import { AppendCanvasMessageDto } from './dto/append-message.dto';
import { ApplyOpDto } from './dto/apply-op.dto';
import { CreateCanvasDto } from './dto/create-canvas.dto';
import { MoveNodeDto } from './dto/move-node.dto';
import { RenameCanvasDto } from './dto/rename-canvas.dto';

@Controller('canvas')
@UseGuards(JwtAuthGuard)
export class CanvasController {
  constructor(private readonly canvas: CanvasService) {}

  @Post()
  create(@Body() dto: CreateCanvasDto, @CurrentUser() user: AuthUser) {
    return this.canvas.create(
      dto.goal,
      dto.title,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }

  /** 画布列表（cursor 分页：?cursor=<上页末项 id>&limit=30，前端滚动加载）。 */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.canvas.list(user.tenantId, {
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** 画布快照（节点 + 边 + 生成节点媒体状态）。 */
  @Get(':id')
  snapshot(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.snapshot(id, user.tenantId);
  }

  /** 画布 agent 对话历史。 */
  @Get(':id/messages')
  messages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.findMessages(id, user.tenantId);
  }

  /** 清空会话记录与 agent 上下文（保留节点/连线与 token 审计）。运行期拒绝。 */
  @Delete(':id/messages')
  clearMessages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.clearMessages(id, user.tenantId);
  }

  @Post(':id/messages')
  append(
    @Param('id') id: string,
    @Body() dto: AppendCanvasMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.appendMessage(
      id,
      dto.content,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }

  /** 重命名画布（仅改标题）。 */
  @Patch(':id')
  rename(
    @Param('id') id: string,
    @Body() dto: RenameCanvasDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.rename(id, dto.title, user.tenantId);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.stop(id, user.tenantId);
  }

  /**
   * 用户结构编辑（空闲期）。actor 固定为 user：运行期由 service 拒绝、乐观并发经 baseRevision。
   * op 形状经 zod 收窄（DTO 只校验信封）。
   */
  @Post(':id/ops')
  async applyOp(
    @Param('id') id: string,
    @Body() dto: ApplyOpDto,
    @CurrentUser() user: AuthUser,
  ) {
    // 归属校验：snapshot 会按 tenantId 过滤；这里先确保画布属于该租户
    await this.canvas.snapshot(id, user.tenantId);
    const op = canvasOpSchema.parse(dto.op);
    return this.canvas.applyOp(id, 'user', op, dto.baseRevision);
  }

  /** 节点位置更新（LWW）。 */
  @Post(':id/nodes/:nodeId/move')
  move(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: MoveNodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.moveNode(id, nodeId, dto.x, dto.y, user.tenantId);
  }
}
