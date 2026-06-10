import { IsOptional, IsString, Matches } from 'class-validator';

export class InstallSkillDto {
  /** GitHub 仓库路径，格式 owner/repo */
  @IsString()
  @Matches(/^[\w.-]+\/[\w.-]+$/)
  repo!: string;

  /** 仓库内子目录，如 document-skills/docx */
  @IsString()
  path!: string;

  /** git ref（branch/tag/SHA），不传时自动尝试 main → master */
  @IsOptional()
  @IsString()
  ref?: string;
}
