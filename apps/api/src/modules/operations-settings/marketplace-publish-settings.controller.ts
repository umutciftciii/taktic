import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { MarketplacePublishSettingsService } from './marketplace-publish-settings.service';

@Controller('operations-settings/marketplace-publish')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class MarketplacePublishSettingsController {
  constructor(
    @Inject(MarketplacePublishSettingsService)
    private readonly settings: MarketplacePublishSettingsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.MARKETPLACE_PUBLISH_WRITE)
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Bu ayar yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setAutoPublishEnabled(dto.enabled, user.id);
  }
}
