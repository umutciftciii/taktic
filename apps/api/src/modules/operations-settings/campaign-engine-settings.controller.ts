import { Body, Controller, ForbiddenException, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { SetSchedulerEnabledDto } from './dto/set-scheduler-enabled.dto';
import { CampaignEngineSwitchService } from './campaign-engine-settings.service';

/**
 * The campaign engine's switch (CMP-004 S4): SUPER_ADMIN only, both ways,
 * because the response carries who switched a credit-granting engine on and
 * when, and because the switch is the one operations decision that starts
 * promotional credit flowing. The operator's identity comes from the
 * session, never from the payload.
 */
@Controller('operations-settings/campaign-engine')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class CampaignEngineSettingsController {
  constructor(@Inject(CampaignEngineSwitchService) private readonly settings: CampaignEngineSwitchService) {}

  @Get()
  get() {
    return this.settings.getForAdmin();
  }

  @Put()
  set(@Body() dto: SetSchedulerEnabledDto, @CurrentUser() user: AuthUser) {
    if (!user?.id) {
      throw new ForbiddenException('Kampanya motoru yalnızca oturum açmış bir yönetici tarafından değiştirilebilir');
    }
    return this.settings.setEnabled(dto.enabled, user.id);
  }
}
