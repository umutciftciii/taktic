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
   * The raw numbers. Never cached; every successful read leaves one
   * SensitiveDataAccessLog row (a refused one leaves none — the guard stops it
   * before the service runs).
   *
   * Layered (CMP-006 PR-C.2): the sensitive permission alone is not enough.
   * The number is read in one operational context — the fraud review of a
   * provider — so the route also demands that context's permissions:
   *
   *   PROVIDER_REGISTRATION_READ_SENSITIVE
   *     ∧ PROMOTION_ELIGIBILITY_REVIEW   (the review the number serves)
   *     ∧ PROVIDERS_READ_DETAIL          (the page the number is shown on)
   *
   * `PermissionsGuard` is conjunctive, so listing the three is the whole rule.
   * No second context is accepted: nothing else in the product — moderation,
   * support, finance — reads a registration number, and an "A ∧ (B ∨ C)" rule
   * would open a path nobody asked for. SUPER_ADMIN passes implicitly.
   */
  @Get(':providerId/business-registration/raw')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(
    AdminPermission.PROVIDER_REGISTRATION_READ_SENSITIVE,
    AdminPermission.PROMOTION_ELIGIBILITY_REVIEW,
    AdminPermission.PROVIDERS_READ_DETAIL,
  )
  @Header('Cache-Control', 'no-store')
  readRaw(@CurrentUser() user: AuthUser, @Param('providerId') providerId: string) {
    return this.registrations.readRaw(user, providerId);
  }
}
