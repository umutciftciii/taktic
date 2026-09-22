import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { CampaignEngineSwitchService } from './campaign-engine-settings.service';

/**
 * The campaign engine's switch (CMP-004 S4): OPERATIONS_SETTINGS_READ to look,
 * and its own CAMPAIGN_ENGINE_TOGGLE to move.
 *
 * The write is deliberately not OPERATIONS_SETTINGS_WRITE (RG-7 §12.4). Every
 * other operations switch is a working preference; this one is the single
 * decision that starts promotional credit flowing, so a role trusted with the
 * others is not thereby trusted with this. Reading is restricted too, because
 * the response carries who switched it and when. The operator's identity comes
 * from the session, never from the payload.
 */
@Controller('operations-settings/campaign-engine')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class CampaignEngineSettingsController {
  constructor(@Inject(CampaignEngineSwitchService) private readonly settings: CampaignEngineSwitchService) {}

  @Get()
  @RequiresPermission(AdminPermission.OPERATIONS_SETTINGS_READ)
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.CAMPAIGN_ENGINE_TOGGLE)
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Kampanya motoru yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setEnabled(dto.enabled, user.id);
  }
}
