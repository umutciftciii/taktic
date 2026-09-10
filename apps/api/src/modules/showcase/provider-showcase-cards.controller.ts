import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateShowcaseCardDto, UpdateShowcaseCardDto } from './dto/create-showcase-card.dto';
import { AcceptShowcasePriceTermsDto } from './dto/showcase-price-terms.dto';
import { SubmitShowcaseCardDto } from './dto/submit-showcase-card.dto';
import { AuthUser } from '../auth/auth.types';
import { ProviderShowcaseCardsService } from './provider-showcase-cards.service';
import { ShowcasePriceTermsService } from './showcase-price-terms.service';

/**
 * A provider's own vitrin cards.
 *
 * Three guards, in order, and each one closes a different door:
 *
 * - `AuthGuard` turns an anonymous call into 401.
 * - `RolesGuard` turns a customer's into 403. SUPER_ADMIN is admitted because
 *   an operator supporting a provider has always been able to act on their
 *   behalf here, exactly as they can on the rest of the provider routes.
 * - `ProviderAccessGuard` binds the `:providerId` in the path to the session,
 *   so a provider cannot address another provider's panel at all.
 *
 * A card belonging to a *different* provider inside a panel the caller does
 * legitimately own is caught one level down, in the service, and answers 404
 * rather than 403 — see `showcaseCardNotFound`.
 *
 * There is no delete route, and there will not be one. A card's versions are
 * the record of what was claimed and what was approved, and a product that can
 * erase that has no audit trail. Retiring a card is `ARCHIVED` — which this
 * phase does give an endpoint, because cards are now on a public page and a
 * business has to be able to take its own down.
 */
@Controller('providers/:providerId/showcase/cards')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
export class ProviderShowcaseCardsController {
  constructor(
    @Inject(ProviderShowcaseCardsService) private readonly cards: ProviderShowcaseCardsService,
    @Inject(ShowcasePriceTermsService) private readonly priceTerms: ShowcasePriceTermsService,
  ) {}

  /**
   * The price-responsibility text the submit endpoint requires acceptance of.
   *
   * Served from the API rather than written into the form, for the reason the
   * refund window on the landing page is: the sentence a provider accepts and
   * the sentence this application records an acceptance of must be one string,
   * not two that are expected to match.
   */
  @Get('price-terms')
  getPriceTerms() {
    return this.cards.getPriceTerms();
  }

  /**
   * The categories this provider may open a card under, per card kind.
   *
   * Declared above `:cardId` for the same reason `price-terms` is: Nest matches
   * routes in declaration order, and a literal segment that comes after a
   * parameter would be swallowed by it.
   *
   * On this controller rather than its own, because it is the same resource
   * seen from the other end — "what may a card of mine point at" — and it needs
   * the identical guard chain. A second controller would be a second place for
   * that chain to be got wrong.
   */
  @Get('eligible-categories')
  listEligibleCategories(@Param('providerId') providerId: string) {
    return this.cards.listEligibleCategories(providerId);
  }

  @Get()
  listCards(@Param('providerId') providerId: string) {
    return this.cards.listCards(providerId);
  }

  @Get(':cardId')
  getCard(@Param('providerId') providerId: string, @Param('cardId') cardId: string) {
    return this.cards.getCard(providerId, cardId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createCard(@Param('providerId') providerId: string, @Body() dto: CreateShowcaseCardDto) {
    return this.cards.createCard(providerId, dto);
  }

  /**
   * What this card is being asked to agree to before its next placement is
   * bought, and whether it already has.
   *
   * Card-scoped, unlike the `price-terms` route above it, and the two answer
   * different questions on purpose. That one serves the sentence the *review*
   * submission requires; this one also says whether this particular card has an
   * acceptance for the version in force — which is what the buying screen needs
   * in order to offer the acceptance rather than a button the checkout refuses.
   */
  @Get(':cardId/price-terms')
  getCardPriceTerms(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
  ) {
    return this.priceTerms.getForCard(providerId, cardId);
  }

  /**
   * Accepts the price-responsibility text for this card.
   *
   * **200 on both the first call and every repeat, and never 201.** What this
   * addresses is the card's acceptance of the terms in force, and after either
   * call it exists; a status that differed between two identical requests would
   * report to the caller a difference they cannot act on and do not have. The
   * body is the acceptance itself either way — the same row, with the same
   * `acceptedAt`, because a re-acceptance does not move the record of when
   * consent was actually given.
   *
   * Nothing about the card changes here. No version is written, no review is
   * opened, no placement is touched: that separation is the whole reason this
   * route exists rather than a second submit.
   */
  @Post(':cardId/price-terms-acceptances')
  @HttpCode(HttpStatus.OK)
  acceptCardPriceTerms(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: AcceptShowcasePriceTermsDto,
  ) {
    return this.priceTerms.acceptForCard(providerId, cardId, user, dto);
  }

  /**
   * An edit. What it produces — a rewritten draft, a new draft for review, or a
   * new live version — is the service's decision, not the caller's: a client
   * that could ask for "publish this without review" would be the whole of the
   * approval rule, undone.
   */
  @Patch(':cardId')
  updateCard(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
    @Body() dto: UpdateShowcaseCardDto,
  ) {
    return this.cards.updateCard(providerId, cardId, dto);
  }

  /**
   * 200 rather than 201: nothing the caller addressed is created — the same card
   * comes back with its draft now waiting for an operator.
   */
  @Post(':cardId/submit')
  @HttpCode(HttpStatus.OK)
  submitCard(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
    @Body() dto: SubmitShowcaseCardDto,
  ) {
    return this.cards.submitCard(providerId, cardId, dto);
  }

  /**
   * Takes a submission back before anybody has ruled on it.
   *
   * No body: there is nothing to say. The card comes from the path, the
   * provider from the guard, and which version is in play is whatever the card's
   * own `draftVersionId` points at — a client that could name a version could
   * name somebody else's.
   *
   * 200 rather than 201: nothing is created that the caller addressed. The same
   * card comes back with its draft returned to them.
   */
  @Post(':cardId/withdraw-submission')
  @HttpCode(HttpStatus.OK)
  withdrawSubmission(
    @Param('providerId') providerId: string,
    @Param('cardId') cardId: string,
  ) {
    return this.cards.withdrawSubmission(providerId, cardId);
  }

  /**
   * Retires a card, and takes whatever it is publishing off the air with it.
   *
   * There is still no delete — the versions are the record of what was claimed
   * and what was approved — but a business that cannot take its own card down
   * is a business advertising work it has stopped doing.
   *
   * **The paid clock keeps running.** A provider who could freeze a run by
   * archiving its card could park a dated placement and spend it whenever the
   * season suited. The two weeks a card spends archived are two weeks of the
   * run, and that is the price of a run being a run.
   *
   * 200 rather than 201: nothing is created, and the same card comes back
   * archived.
   */
  @Post(':cardId/archive')
  @HttpCode(HttpStatus.OK)
  archiveCard(@Param('providerId') providerId: string, @Param('cardId') cardId: string) {
    return this.cards.archiveCard(providerId, cardId);
  }

  /** Brings a retired card back, and resumes whatever is left of its run. */
  @Post(':cardId/unarchive')
  @HttpCode(HttpStatus.OK)
  unarchiveCard(@Param('providerId') providerId: string, @Param('cardId') cardId: string) {
    return this.cards.unarchiveCard(providerId, cardId);
  }
}
