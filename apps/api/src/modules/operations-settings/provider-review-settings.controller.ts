import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { ProviderReviewSettingsService } from './provider-review-settings.service';

@Controller('operations-settings/provider-reviews')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class ProviderReviewSettingsController {
  constructor(
    @Inject(ProviderReviewSettingsService)
    private readonly settings: ProviderReviewSettingsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_SETTING_WRITE)
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Bu ayar yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setEnabled(dto.enabled, user.id);
  }
}
