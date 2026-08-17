import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ListNotificationLogsDto } from './dto/list-notification-logs.dto';
import { NotificationLogService } from './notification-log.service';

/**
 * SUPER_ADMIN only, GET only.
 *
 * The audit trail says who the platform contacted and when, which makes it a
 * privacy surface even though every recipient in it is masked. AuthGuard turns
 * an anonymous call into 401 and RolesGuard turns a customer's or provider's
 * into 403 — no role but SUPER_ADMIN reaches the service.
 */
@Controller('notification-logs')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class NotificationLogController {
  constructor(
    @Inject(NotificationLogService) private readonly notificationLogs: NotificationLogService,
  ) {}

  @Get()
  listNotificationLogs(@Query() query: ListNotificationLogsDto) {
    return this.notificationLogs.listNotificationLogs(query);
  }

  @Get(':id')
  getNotificationLog(@Param('id') id: string) {
    return this.notificationLogs.getNotificationLog(id);
  }
}
