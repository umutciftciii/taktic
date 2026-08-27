import { Body, Controller, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CompanySettingsService } from './company-settings.service';
import { SaveCompanySettingsDto } from './dto/save-company-settings.dto';

/**
 * SUPER_ADMIN only, both ways.
 *
 * These three values appear in the footer of every transactional e-mail the
 * platform sends, so writing them is a platform-wide act; AuthGuard turns an
 * anonymous call into 401 and RolesGuard turns a customer's or a provider's
 * into 403.
 *
 * Nothing technical is reachable from here. There is no endpoint for the
 * transport, the Resend key or the sender address, and none of them appears in
 * a response: those are deployment configuration and a credential, and an admin
 * screen that could read them would be a way to exfiltrate them with an admin
 * session rather than a shell.
 */
@Controller('company-settings')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class CompanySettingsController {
  constructor(
    @Inject(CompanySettingsService) private readonly companySettings: CompanySettingsService,
  ) {}

  @Get()
  getCompanySettings() {
    return this.companySettings.getForAdmin();
  }

  @Put()
  saveCompanySettings(@Body() dto: SaveCompanySettingsDto, @CurrentUser() user: AuthUser) {
    return this.companySettings.save(dto, user?.id ?? null);
  }
}
