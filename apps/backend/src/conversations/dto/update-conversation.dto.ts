import { IsBoolean } from 'class-validator';

export class UpdateConversationDto {
  /** 侧栏置顶 / 取消置顶。 */
  @IsBoolean()
  pinned!: boolean;
}
