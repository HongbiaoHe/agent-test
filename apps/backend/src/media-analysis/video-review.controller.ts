import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VideoReviewService } from './video-review.service';

export class VideoReviewDto {
  /** 低清预览经 POST /media-api/uploads 上传后拿到的版本 id */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  versionId!: string;

  /** 这条片子的意图：目标、平台、时长、脚本 / 分镜要点（agent 从对话里整理） */
  @IsString()
  @MaxLength(4000)
  brief!: string;

  /** 时间线概要（@agent-test/video-schema 的 reviewOutline） */
  @IsString()
  @MaxLength(20000)
  outline!: string;
}

/** Spark 桌面端剪辑工程的整片审片（review_video_project 工具），归属同 /media-api：按登录用户校验 */
@Controller('media-api/video-reviews')
@UseGuards(JwtAuthGuard)
export class VideoReviewController {
  constructor(private readonly reviews: VideoReviewService) {}

  @Post()
  review(@Body() dto: VideoReviewDto, @CurrentUser() user: AuthUser) {
    return this.reviews.review({
      userId: user.userId,
      versionId: dto.versionId,
      brief: dto.brief,
      outline: dto.outline,
    });
  }
}
