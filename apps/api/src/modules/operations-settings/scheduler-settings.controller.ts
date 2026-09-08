import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { isSchedulerJobKey } from './scheduler-jobs';
import { SchedulerSettingsService } from './scheduler-settings.service';

/**
 * SUPER_ADMIN only, both ways — the same rule, for the same reason, as the
 * operations settings this sits beside.
 *
 * Reading is restricted alongside writing because the response carries the
 * toggle history: who switched the refund worker on, and when. That is not an
 * operations-staff fact, and no customer- or provider-facing session reaches
 * this controller at all.
 *
 * What the response deliberately does **not** carry is any other configuration.
 * The cron expression is here because an operator has to see the schedule they
 * cannot change; no other environment value, credential or internal error text
 * is exposed, and an unknown job key produces a plain 404 rather than a hint
 * about what keys do exist.
 */
@Controller('operations-settings/schedulers')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SchedulerSettingsController {
  constructor(
    @Inject(SchedulerSettingsService)
    private readonly schedulers: SchedulerSettingsService,
  ) {}

  @Get()
  list() {
    return this.schedulers.listForAdmin();
  }

  @Put(':job')
  setEnabled(
    @Param('job') job: string,
    @Body() dto: SetSchedulerEnabledDto,
    @CurrentUser() user: AuthUser,
  ) {
    // Checked before anything else: an unknown key is not a setting that
    // happens to be missing, it is a request for something that does not exist.
    if (!isSchedulerJobKey(job)) {
      throw new NotFoundException('Böyle bir zamanlanmış iş yok');
    }

    // The audit row's operator is NOT NULL in the database, so an anonymous
    // toggle is refused here rather than failing halfway through the
    // transaction. AuthGuard already makes this unreachable; it stays because
    // the audit trail's value rests on it.
    if (!user?.id) {
      throw new ForbiddenException(
        'Zamanlanmış işler yalnızca oturum açmış bir yönetici tarafından değiştirilebilir',
      );
    }

    return this.schedulers.setEnabled(job, dto.enabled, user.id);
  }
}
