import { Body, Controller, Get, Header, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { AdminPermission, UserRole } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BusinessRegistrationService } from './business-registration.service';
import { UpdateBusinessRegistrationDto } from './dto/update-business-registration.dto';

@Controller('providers')
export class BusinessRegistrationController {
  constructor(@Inject(BusinessRegistrationService) private readonly registrations: BusinessRegistrationService) {}

  /** The provider's own registration: type and masked number, plus the masked legacy pair. */
  @Get('me/business-registration')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  getOwn(@CurrentUser() user: AuthUser) {
    return this.registrations.getOwn(user);
  }

  /** The provider replacing their own declaration. Operators have no write route here. */
  @Put('me/business-registration')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER)
  updateOwn(@CurrentUser() user: AuthUser, @Body() dto: UpdateBusinessRegistrationDto) {
    return this.registrations.updateOwn(user, dto);
  }

  /**
   * The raw numbers. Its own permission — PROVIDERS_READ_DETAIL is not enough —
   * and every call leaves a SensitiveDataAccessLog row. Never cached.
   */
  @Get(':providerId/business-registration/raw')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PROVIDER_REGISTRATION_READ_SENSITIVE)
  @Header('Cache-Control', 'no-store')
  readRaw(@CurrentUser() user: AuthUser, @Param('providerId') providerId: string) {
    return this.registrations.readRaw(user, providerId);
  }
}
