import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { CompanySettingsService } from './company-settings.service';
import { SaveCompanySettingsDto } from './dto/save-company-settings.dto';

/**
 * COMPANY_SETTINGS_READ and COMPANY_SETTINGS_WRITE, as two permissions.
 *
 * These three values appear in the footer of every transactional e-mail the
 * platform sends, so writing them is a platform-wide act; AuthGuard turns an
 * anonymous call into 401, AdminAccessGuard turns a non-staff caller's into 403,
 * and PermissionsGuard requires the capability the route names.
 *
 * Nothing technical is reachable from here. There is no endpoint for the
 * transport, the Resend key or the sender address, and none of them appears in
 * a response: those are deployment configuration and a credential, and an admin
 * screen that could read them would be a way to exfiltrate them with an admin
 * session rather than a shell.
 */
@Controller('company-settings')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class CompanySettingsController {
  constructor(
    @Inject(CompanySettingsService) private readonly companySettings: CompanySettingsService,
  ) {}

  @Get()
  @RequiresPermission(AdminPermission.COMPANY_SETTINGS_READ)
  getCompanySettings() {
    return this.companySettings.getForAdmin();
  }

  @Put()
  @RequiresPermission(AdminPermission.COMPANY_SETTINGS_WRITE)
  saveCompanySettings(@Body() dto: SaveCompanySettingsDto, @CurrentUser() user: AuthUser) {
    return this.companySettings.save(dto, user?.id ?? null);
  }
}
