import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ListNotificationLogsDto } from './dto/list-notification-logs.dto';
import { NotificationLogService } from './notification-log.service';
import { NotificationRetryService } from './notification-retry.service';

/**
 * SUPER_ADMIN only.
 *
 * The audit trail says who the platform contacted and when, which makes it a
 * privacy surface even though every recipient in it is masked. AuthGuard turns
 * an anonymous call into 401 and RolesGuard turns a customer's or provider's
 * into 403 — no role but SUPER_ADMIN reaches the service.
 *
 * The reads are the whole of it apart from one deliberate write: the retry,
 * which re-sends a row that already exists. Note what its route does *not*
 * accept — there is no body, no recipient, no template and no template data,
 * only the id of the row being retried. Everything the message will say is
 * rebuilt from domain data on the server, so this endpoint cannot be used to
 * mail arbitrary text to an arbitrary address with an admin session.
 */
@Controller('notification-logs')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class NotificationLogController {
  constructor(
    @Inject(NotificationLogService) private readonly notificationLogs: NotificationLogService,
    @Inject(NotificationRetryService) private readonly retries: NotificationRetryService,
  ) {}

  @Get()
  listNotificationLogs(@Query() query: ListNotificationLogsDto) {
    return this.notificationLogs.listNotificationLogs(query);
  }

  @Get(':id')
  getNotificationLog(@Param('id') id: string) {
    return this.notificationLogs.getNotificationLog(id);
  }

  /**
   * Re-sends one failed, reproducible transactional e-mail.
   *
   * 200 rather than 201: nothing is created — the same audit row is re-used, and
   * the response is that row's current state, whatever the attempt produced.
   * A refused retry answers 400 (this row may never be retried) or 409 (this
   * row is not available right now, because another attempt holds it).
   */
  @Post(':id/retry')
  @HttpCode(200)
  retryNotification(@Param('id') id: string) {
    return this.retries.retryNotification(id);
  }
}
