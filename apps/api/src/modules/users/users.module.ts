import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminInviteController } from './admin-invite.controller';
import { AdminInviteService } from './admin-invite.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [UsersController, AdminInviteController],
  providers: [UsersService, AdminInviteService],
})
export class UsersModule {}
