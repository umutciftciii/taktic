import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminPermission, UserRole } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { UpdateAutoRenewDto } from './dto/update-auto-renew.dto';
import { EntitlementsService, assertProviderAccount } from './entitlements.service';
import { OfferPackagesService } from './offer-packages.service';

/**
 * Everything about a provider's bought periods sits behind
 * {@link ProviderAccessGuard}: the provider themselves, or a SUPER_ADMIN. A
 * customer, another provider and an anonymous caller get a 403 from the guard
 * before any handler runs, and nothing on these routes has an unauthenticated
 * variant.
 *
 * Reading is available to both roles; *changing* what renews is not. Buying and
 * cancelling are acts of the account that owns the provider, so the two write
 * handlers additionally refuse anyone who is not the provider account — the
 * same rule the checkout endpoint already applies.
 */
@Controller()
export class EntitlementsController {
  constructor(
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(OfferPackagesService) private readonly packages: OfferPackagesService,
  ) {}

  /**
   * The provider's own periods.
   *
   * A SUPER_ADMIN gets the same rows plus the audit trail: the purchase, the
   * renewal attempts and the payment provider's opaque transaction reference.
   * Never a stored payment credential — that is reported only as a boolean.
   */
  @Get('providers/:providerId/entitlements')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listEntitlements(@Param('providerId') providerId: string, @CurrentUser() user: AuthUser) {
    return user.role === UserRole.SUPER_ADMIN
      ? this.entitlements.listProviderEntitlementsForAdmin(providerId)
      : this.entitlements.listProviderEntitlements(providerId);
  }

  /**
   * One provider's periods, read by staff (ADMIN-DESIGN-000, F4).
   *
   * The admin projection the SUPER_ADMIN branch above returns (purchase,
   * renewal attempts, the payment provider's opaque reference, never a stored
   * credential) on the permission that already reads purchases and their
   * payment references. `ProviderAccessGuard` is not widened. The two write
   * routes below stay the provider account's alone.
   */
  @Get('admin/providers/:providerId/entitlements')
  @UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
  @RequiresPermission(AdminPermission.PACKAGE_PURCHASES_READ)
  listEntitlementsForAdmin(@Param('providerId') providerId: string) {
    return this.entitlements.listProviderEntitlementsForAdmin(providerId);
  }

  /**
   * The buying screen's catalogue: one-time credits, monthly quota and the
   * unlimited packages this provider is actually allowed to buy.
   */
  @Get('providers/:providerId/offer-packages')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  listOfferPackages(@Param('providerId') providerId: string) {
    return this.packages.listForProvider(providerId);
  }

  @Patch('providers/:providerId/entitlements/:entitlementId/auto-renew')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  updateAutoRenew(
    @Param('providerId') providerId: string,
    @Param('entitlementId') entitlementId: string,
    @Body() dto: UpdateAutoRenewDto,
    @CurrentUser() user: AuthUser,
  ) {
    assertProviderAccount(user);
    return this.entitlements.setAutoRenew(providerId, entitlementId, dto.enabled);
  }

  /**
   * Cancels the next charge and nothing else. The period runs to its own
   * `endAt`, which is why this is not a delete.
   */
  @Post('providers/:providerId/entitlements/:entitlementId/cancel')
  @UseGuards(AuthGuard, ProviderAccessGuard)
  cancelAutoRenew(
    @Param('providerId') providerId: string,
    @Param('entitlementId') entitlementId: string,
    @CurrentUser() user: AuthUser,
  ) {
    assertProviderAccount(user);
    return this.entitlements.cancelAutoRenew(providerId, entitlementId);
  }
}
