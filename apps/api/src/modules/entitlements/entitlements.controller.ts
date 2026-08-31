import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
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
