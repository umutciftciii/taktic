import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { ServiceIssueSettingsService } from './service-issue-settings.service';

@Controller('operations-settings/service-issues')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class ServiceIssueSettingsController {
  constructor(
    @Inject(ServiceIssueSettingsService)
    private readonly settings: ServiceIssueSettingsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.SERVICE_ISSUE_SETTING_WRITE)
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Bu ayar yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setEnabled(dto.enabled, user.id);
  }
}
