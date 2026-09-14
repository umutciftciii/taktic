import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { MarketplacePublishSettingsService } from './marketplace-publish-settings.service';

@Controller('operations-settings/marketplace-publish')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class MarketplacePublishSettingsController {
  constructor(
    @Inject(MarketplacePublishSettingsService)
    private readonly settings: MarketplacePublishSettingsService,
  ) {}

  @Get()
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Bu ayar yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setAutoPublishEnabled(dto.enabled, user.id);
  }
}
