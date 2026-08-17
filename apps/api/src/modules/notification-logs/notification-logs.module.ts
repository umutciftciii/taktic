import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationLogController } from './notification-log.controller';
import { NotificationLogService } from './notification-log.service';

/**
 * Kept separate from NotificationsModule on purpose: that module is the sending
 * side — global, transport-bound and depended on by half the application — and
 * this one only reads. Nothing here can affect a dispatch.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [NotificationLogController],
  providers: [NotificationLogService],
})
export class NotificationLogsModule {}
