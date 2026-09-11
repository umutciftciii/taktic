import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ShowcaseCardKind, ShowcaseLeadStatus, UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { CreateShowcasePackageCheckoutDto } from './dto/showcase-package-checkout.dto';
import { ShowcaseEntitlementService } from './showcase-entitlement.service';
import { ShowcaseLeadService } from './showcase-lead.service';
import { ShowcasePackageCheckoutService } from './showcase-package-checkout.service';
import { ShowcasePackagesService } from './showcase-packages.service';
import { ShowcasePlacementReadService } from './showcase-placement-read.service';
import { ShowcasePublicationService } from './showcase-publication.service';

/**
 * A provider's own vitrin runs, and the leads they produce.
 *
 * The same three guards as the card controller, in the same order and for the
 * same reasons: 401 for an anonymous caller, 403 for a customer, and the path's
 * `:providerId` bound to the session so one business cannot address another's
 * panel.
 *
 * SUPER_ADMIN is admitted to the read routes because an operator supporting a
 * business has always been able to see what they see. It is **not** admitted to
 * the checkout: buying is an act of the account that owns the business, and the
 * service refuses any role but PROVIDER there — the same rule
 * `PaymentsService.createCheckoutSession` already applies to credit packages.
 *
 * The sale is package-first: `packages/checkout` buys a publication right and
 * names no card. The card-bound routes (`placements/checkout`,
 * `placements/eligibility`) are gone, and `showcase-legacy-routes.spec.ts`
 * holds their 404.
 */
@Controller('providers/:providerId/showcase')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
export class ProviderShowcasePlacementsController {
  constructor(
    @Inject(ShowcasePackagesService) private readonly packages: ShowcasePackagesService,
    @Inject(ShowcasePackageCheckoutService)
    private readonly checkout: ShowcasePackageCheckoutService,
    @Inject(ShowcaseEntitlementService)
    private readonly entitlements: ShowcaseEntitlementService,
    @Inject(ShowcasePlacementReadService)
    private readonly placements: ShowcasePlacementReadService,
    @Inject(ShowcaseLeadService) private readonly leads: ShowcaseLeadService,
    @Inject(ShowcasePublicationService)
    private readonly publication: ShowcasePublicationService,
  ) {}

  /**
   * Where every card of this business stands, as one state and one next action
   * each.
   *
   * The panel reads this instead of assembling the answer from the card list,
   * the placement list, the purchase list and an eligibility dry run. See
   * `ShowcasePublicationService` for why those four could disagree — and did,
   * on the most common screen in the feature.
   */
  @Get('publication')
  listPublication(@Param('providerId') providerId: string) {
    return this.publication.listForProvider(providerId);
  }

  /**
   * The price-responsibility text the package sale requires acceptance of, and
   * whether this business has already agreed to the version in force.
   *
   * Declared above `packages` for the reason `price-terms` is declared before
   * `:cardId` on the card controller: Nest matches in declaration order, and a
   * literal segment declared after a broader route would be swallowed by it.
   */
  @Get('packages/terms')
  getPackageTerms(@Param('providerId') providerId: string) {
    return this.checkout.getTerms(providerId);
  }

  /**
   * Opens a checkout for one package — the package-first sale.
   *
   * 201: a purchase row is genuinely created (or an open one for the same
   * package is handed back, which is the same resource either way). What is
   * bought is a publication right; the card that spends it comes later.
   */
  @Post('packages/checkout')
  @HttpCode(HttpStatus.CREATED)
  createPackageCheckout(
    @Param('providerId') providerId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateShowcasePackageCheckoutDto,
  ) {
    return this.checkout.createCheckout(providerId, user, dto);
  }

  /** The rights this business holds: available ones, and the one each card has reserved. */
  @Get('entitlements')
  listEntitlements(@Param('providerId') providerId: string) {
    return this.entitlements.listForProvider(providerId, new Date());
  }

  /**
   * The catalogue, narrowed to what this card's kind can be sold.
   *
   * Declared before `placements/:id` for the reason `packages/terms` is
   * declared before it: Nest matches in declaration order, and a literal
   * segment after a parameter would be swallowed by it.
   */
  @Get('packages')
  listPackages(@Query('cardKind') cardKind?: ShowcaseCardKind) {
    return this.packages.listForProvider(cardKind);
  }

  @Get('placements')
  listPlacements(@Param('providerId') providerId: string) {
    return this.placements.listForProvider(providerId);
  }

  @Get('placements/:placementId')
  getPlacement(
    @Param('providerId') providerId: string,
    @Param('placementId') placementId: string,
  ) {
    return this.placements.getForProvider(providerId, placementId);
  }

  /**
   * The lead inbox.
   *
   * Separate from `GET /providers/:id/requests` because it reads different
   * rows: a direct lead is SUBMITTED until its addressee answers it, and the
   * discovery list is APPROVED by definition. Merging them would mean widening
   * the discovery query to admit unmoderated requests — which is precisely what
   * the direct gate exists to avoid doing generally.
   */
  @Get('leads')
  listLeads(
    @Param('providerId') providerId: string,
    @Query('status') status?: ShowcaseLeadStatus,
  ) {
    return this.leads.listForProvider(providerId, status);
  }

  @Get('leads/:leadId')
  getLead(@Param('providerId') providerId: string, @Param('leadId') leadId: string) {
    return this.leads.getForProvider(providerId, leadId);
  }
}
