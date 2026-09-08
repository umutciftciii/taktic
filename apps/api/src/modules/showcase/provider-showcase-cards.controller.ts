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
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateShowcaseCardDto, UpdateShowcaseCardDto } from './dto/create-showcase-card.dto';
import { SubmitShowcaseCardDto } from './dto/submit-showcase-card.dto';
import { ProviderShowcaseCardsService } from './provider-showcase-cards.service';

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
 * There is no delete route. A card's versions are the record of what was
 * claimed and what was approved, and a product that can erase that has no audit
 * trail. Retiring a card is `ARCHIVED`, which no endpoint writes yet.
 */
@Controller('providers/:providerId/showcase/cards')
@UseGuards(AuthGuard, RolesGuard, ProviderAccessGuard)
@Roles(UserRole.PROVIDER, UserRole.SUPER_ADMIN)
export class ProviderShowcaseCardsController {
  constructor(
    @Inject(ProviderShowcaseCardsService) private readonly cards: ProviderShowcaseCardsService,
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
}
