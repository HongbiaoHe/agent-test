import { IsNotEmpty, IsString } from 'class-validator';

export class AppendMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;
}
