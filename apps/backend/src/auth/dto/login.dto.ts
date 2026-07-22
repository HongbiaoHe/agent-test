import { IsEmail, IsString, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6, { message: '验证码必须是6位数字' })
  code!: string;
}
