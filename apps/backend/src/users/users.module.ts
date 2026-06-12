import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** 无 imports 数组是有意的：PrismaModule 与 AuthModule 均为 @Global()，
 *  PrismaService / PasskeyService 不需要在此声明即可注入。 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
