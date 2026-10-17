import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/** POST /preview/file：为工作区里的一个 HTML 入口签发静态网页预览地址。 */
export class CreateFilePreviewDto {
  /** 入口 HTML 的工作区相对路径（如 `todo-vite/index.html`） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  @Matches(/\.html?$/i, { message: 'path 必须是 .html / .htm 文件' })
  path!: string;
}
