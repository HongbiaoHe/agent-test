import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { type AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConversationsService } from './conversations.service';
import { AppendMessageDto } from './dto/append-message.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  create(@Body() dto: CreateConversationDto, @CurrentUser() user: AuthUser) {
    return this.conversations.create(
      dto.goal,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.conversations.list(user.tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.conversations.findOne(id, user.tenantId);
  }

  @Post(':id/messages')
  append(
    @Param('id') id: string,
    @Body() dto: AppendMessageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.conversations.appendMessage(
      id,
      dto.content,
      user.tenantId,
      user.userId,
      dto.model,
    );
  }
}
