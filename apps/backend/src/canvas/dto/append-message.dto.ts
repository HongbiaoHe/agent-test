import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CANVAS_MODELS } from '../canvas.types';

export class AppendCanvasMessageDto {
  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  @IsIn(CANVAS_MODELS)
  model?: string;
}
