import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** 去首尾空白：表单里多敲的空格不该让校验失败或落进 SKILL.md。 */
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * 修改手写技能：说明 + 正文（名字不可改）。
 * 正文上限 100k 字符：UTF-8 最多约 300KB，低于 readSkillFiles 的 512KB 单文件上限，
 * 否则运行时会静默跳过这个 SKILL.md。
 */
export class UpdateCustomSkillDto {
  /** 说明：模型据此判断何时用这个技能（写进 frontmatter 的 description） */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  description!: string;

  /** SKILL.md 正文（Markdown，不含 frontmatter） */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body!: string;
}

/** 新建手写技能：名字规则同 skill-parser 的 validateSkill（也是 /命令 名与目录名）。 */
export class CreateCustomSkillDto extends UpdateCustomSkillDto {
  @Transform(trim)
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, {
    message: 'name 只允许小写字母、数字、连字符，首尾须为字母或数字，总长 ≤64',
  })
  name!: string;
}
