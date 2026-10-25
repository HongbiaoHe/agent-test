import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  cleanFilename,
  type UploadFileInput,
} from '../media/media-upload.service';
import { canvasOpSchema } from './canvas.op-schema';
import { CanvasService } from './canvas.service';
import { AppendCanvasMessageDto } from './dto/append-message.dto';
import { ApplyOpDto } from './dto/apply-op.dto';
import { CreateCanvasDto } from './dto/create-canvas.dto';
import { MoveNodeDto } from './dto/move-node.dto';
import { UpdateCanvasDto } from './dto/update-canvas.dto';
import { SetFocusDto } from './dto/set-focus.dto';

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
      dto.thinkingLevel,
      dto.approvalMode,
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

  /** token 用量报表：会话总计 + 按模型 + 按轮（含每次调用明细与缓存命中量）。 */
  @Get(':id/token-usage')
  tokenUsage(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.tokenReport(id, user.tenantId);
  }

  /** 清空会话记录与 agent 上下文（保留节点/连线与 token 审计）。运行期拒绝。 */
  @Delete(':id/messages')
  clearMessages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.clearMessages(id, user.tenantId);
  }

  /** 手动作废当前任务计划（后续对话不再受它影响）。 */
  @Delete(':id/plan')
  clearPlan(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.canvas.clearPlan(id, user.tenantId);
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
      dto.thinkingLevel,
      dto.approvalMode,
      dto.attachmentVersionIds,
    );
  }

  /**
   * 对话输入框的附件上传（同 POST /conversations/:id/uploads）：请求体就是文件二进制，
   * 返回暂存（staged）的资产，随下一条消息的 attachmentVersionIds 发出时才转正。
   */
  @Post(':id/uploads')
  uploadAttachment(
    @Param('id') id: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Query('filename') filename: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.uploadAttachment(
      id,
      user.tenantId,
      user.userId,
      readUploadFile(contentType, contentLength, filename, req),
    );
  }

  /** 给上传节点传文件（请求体同上）：传完直接挂到节点上，下游即可当参考素材用。 */
  @Post(':id/nodes/:nodeId/upload')
  uploadNodeFile(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Query('filename') filename: string | undefined,
    @Req() req: Request,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.uploadNodeFile(
      id,
      user.tenantId,
      user.userId,
      nodeId,
      readUploadFile(contentType, contentLength, filename, req),
    );
  }

  /** 重命名 / 置顶（只改传了的字段）。 */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCanvasDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.update(id, user.tenantId, dto);
  }

  /**
   * 设置 / 清空「加入对话」的节点圈选。生效范围是整个会话（不随单条消息），
   * 之后注入给 agent 的画布状态只列这些节点，直到用户取消。
   */
  @Post(':id/focus')
  setFocus(
    @Param('id') id: string,
    @Body() dto: SetFocusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.setFocus(id, user.tenantId, dto.nodeIds);
  }

  /**
   * 手动触发 image_gen / video_gen 节点的生成（卡片上的 Generate；
   * agent 那条路走 generate_media_node 工具，两者共用 service 里的同一段逻辑）。
   */
  @Post(':id/nodes/:nodeId/generate')
  generateMediaNode(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.generateMediaNode(
      id,
      user.tenantId,
      user.userId,
      nodeId,
    );
  }

  /** 手动触发 video_concat 节点的拼接（卡片上的 Merge；agent 那条路走 merge_video_node 工具）。 */
  @Post(':id/nodes/:nodeId/merge')
  mergeVideoNode(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.canvas.mergeVideoNode(id, user.tenantId, user.userId, nodeId);
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

/**
 * 原始请求 → 上传文件描述。非 JSON 的 Content-Type 不会被全局 body parser 消费，req 仍是完整的原始流。
 * Content-Type 去掉 `; charset=...` 之类的参数，白名单按纯 MIME 比对。
 */
function readUploadFile(
  contentType: string | undefined,
  contentLength: string | undefined,
  filename: string | undefined,
  req: Request,
): UploadFileInput {
  return {
    contentType: (contentType ?? '').split(';')[0].trim().toLowerCase(),
    size: Number(contentLength),
    filename: cleanFilename(filename),
    body: req,
  };
}
