import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationLogController } from './notification-log.controller';
import { NotificationLogService } from './notification-log.service';
import { NotificationRetryService } from './notification-retry.service';

/**
 * Kept separate from NotificationsModule on purpose: that module is the sending
 * side — global, transport-bound and depended on by half the application — and
 * this one is the operator's view of it.
 *
 * The dispatcher and the transactional composer are reached through the global
 * module rather than imported, so this module still owns no transport and no
 * template. What it adds is one guarded action over a row that already exists;
 * see NotificationRetryService for why that is not a second sending path.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [NotificationLogController],
  providers: [NotificationLogService, NotificationRetryService],
})
export class NotificationLogsModule {}
