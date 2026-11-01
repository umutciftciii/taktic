import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { mayEmbed } from '../auth/embedded-permissions';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { SystemHealthService } from './system-health.service';

/**
 * ADMIN-SYSTEM-HEALTH-001. OPERATIONS_SETTINGS_READ opens the report — the
 * scheduler half is the operations screen's own subject — and the e-mail half
 * is NOTIFICATION_LOGS_READ's: without it the `email` key is absent, not
 * empty (mayEmbed). Holding only NOTIFICATION_LOGS_READ opens nothing here.
 *
 * One GET and no other verb: the screen looks, it never acts. There is no
 * parameter either — what is probed is the deployment's configuration, never
 * the caller's choice.
 */
@Controller('system-health')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class SystemHealthController {
  constructor(@Inject(SystemHealthService) private readonly health: SystemHealthService) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  report(@CurrentUser() user: AuthUser) {
    return this.health.report({
      includeEmail: mayEmbed(user, AdminPermission.NOTIFICATION_LOGS_READ),
      // OBS-ALERT-002: managed recipients' ids, labels and count.
      includeRecipients: mayEmbed(user, AdminPermission.OPS_ALERT_RECIPIENTS_READ),
    });
  }
}
