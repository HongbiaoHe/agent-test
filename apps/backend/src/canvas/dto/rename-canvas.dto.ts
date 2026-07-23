import { IsString, MaxLength } from 'class-validator';

/** 画布重命名：仅改标题。空白/超长由 service 与此处共同兜底。 */
export class RenameCanvasDto {
  @IsString()
  @MaxLength(100)
  title!: string;
}
