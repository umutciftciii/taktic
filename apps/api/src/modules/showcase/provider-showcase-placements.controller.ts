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
import { CreateShowcaseCheckoutDto } from './dto/showcase-checkout.dto';
import { ShowcaseCheckoutService } from './showcase-checkout.service';
import { ShowcaseLeadService } from './showcase-lead.service';
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
 */
@Controller('providers/:providerId/showcase')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
export class ProviderShowcasePlacementsController {
  constructor(
    @Inject(ShowcasePackagesService) private readonly packages: ShowcasePackagesService,
    @Inject(ShowcaseCheckoutService) private readonly checkout: ShowcaseCheckoutService,
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
   * The catalogue, narrowed to what this card's kind can be sold.
   *
   * Declared before `placements/:id` for the reason `price-terms` is declared
   * before `:cardId` on the card controller: Nest matches in declaration order,
   * and a literal segment after a parameter would be swallowed by it.
   */
  @Get('packages')
  listPackages(@Query('cardKind') cardKind?: ShowcaseCardKind) {
    return this.packages.listForProvider(cardKind);
  }

  /**
   * The dry run behind the buy button: can this card be published, and why not.
   *
   * Writes nothing and opens nothing. It runs the identical checks the checkout
   * does, so a button that is enabled here cannot be refused there.
   */
  @Get('placements/eligibility')
  checkEligibility(
    @Param('providerId') providerId: string,
    @Query('cardId') cardId: string,
    @Query('showcasePackageId') showcasePackageId?: string,
  ) {
    return this.checkout.checkEligibility(providerId, cardId, showcasePackageId);
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
   * Opens a checkout for one card and one package.
   *
   * 201: a purchase row is genuinely created (or an open one for the same card
   * and package is handed back, which is the same resource either way).
   */
  @Post('placements/checkout')
  @HttpCode(HttpStatus.CREATED)
  createCheckout(
    @Param('providerId') providerId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateShowcaseCheckoutDto,
  ) {
    return this.checkout.createCheckout(providerId, user, dto);
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
