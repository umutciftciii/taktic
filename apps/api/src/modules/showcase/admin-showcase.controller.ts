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
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { AdminShowcaseService } from './admin-showcase.service';
import { ShowcasePriceTermsService } from './showcase-price-terms.service';
import {
  ListShowcaseCardsDto,
  ListShowcaseVersionsDto,
  RejectShowcaseVersionDto,
  SuspendShowcaseCardDto,
} from './dto/review-showcase-version.dto';

/**
 * Vitrin cards, for the operator. SUPER_ADMIN only.
 *
 * A separate prefix, separate guards and a separate service from the provider's
 * routes, for the reason the support desk splits the same way: nothing an
 * operator may do is reachable by widening a provider endpoint, and nothing a
 * provider may do is reachable by calling an operator one.
 *
 * Note what is absent. There is no create and no edit, so an operator cannot
 * author a card in a business's name or change what one says about its own
 * price. There is no delete, so nothing here removes the record of what was
 * claimed. And there is no route that un-decides a version: a refused version
 * stays refused, with its reason attached, and the provider's answer to it is
 * their next version.
 */
@Controller('admin/showcase')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminShowcaseController {
  constructor(
    @Inject(AdminShowcaseService) private readonly showcase: AdminShowcaseService,
    @Inject(ShowcasePriceTermsService) private readonly priceTerms: ShowcasePriceTermsService,
  ) {}

  /**
   * Who accepted which version of the price-responsibility text, and when.
   *
   * **Read-only, and there is deliberately no companion that writes or clears
   * one.** The rows are a record of consent; an operator route that could add
   * or remove one would make the record say what the platform wanted rather
   * than what a business agreed to, and the table's whole point would be gone.
   * A correction, if one is ever genuinely needed, is a migration somebody has
   * to write down — not a button.
   *
   * Every version is listed, not only the one in force. The question asked here
   * is historical, and a list narrowed to today's terms would hide exactly the
   * history the table exists to keep.
   */
  @Get('price-terms-acceptances')
  listPriceTermsAcceptances(
    @Query('providerId') providerId?: string,
    @Query('cardId') cardId?: string,
    @Query('termsVersion') termsVersion?: string,
  ) {
    return this.priceTerms.listForAdmin({ providerId, cardId, termsVersion });
  }

  /** The queue. Defaults to PENDING — what is actually waiting on somebody. */
  @Get('versions')
  listVersions(@Query() query: ListShowcaseVersionsDto) {
    return this.showcase.listVersions(query);
  }

  @Get('versions/:versionId')
  getVersion(@Param('versionId') versionId: string) {
    return this.showcase.getVersion(versionId);
  }

  /**
   * 200 rather than 201 for both decisions: the review row is a side effect of
   * the decision, not a resource the caller addressed. What comes back is the
   * version in its new state.
   */
  @Post('versions/:versionId/approve')
  @HttpCode(HttpStatus.OK)
  approveVersion(@Param('versionId') versionId: string, @CurrentUser() user: AuthUser) {
    return this.showcase.approveVersion(versionId, user);
  }

  @Post('versions/:versionId/reject')
  @HttpCode(HttpStatus.OK)
  rejectVersion(
    @Param('versionId') versionId: string,
    @Body() dto: RejectShowcaseVersionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.showcase.rejectVersion(versionId, user, dto.note);
  }

  @Get('cards')
  listCards(@Query() query: ListShowcaseCardsDto) {
    return this.showcase.listCards(query);
  }

  @Get('cards/:cardId')
  getCard(@Param('cardId') cardId: string) {
    return this.showcase.getCard(cardId);
  }

  /**
   * Pulls a card off the air, and every paid run of it with it.
   *
   * Phase one reserved this state and left it with no writer, on the grounds
   * that nothing rendered a card to anybody. Phase two puts approved cards on
   * the home page and lets them collect leads, so an operator who could not
   * pull one they had already approved would be an operator whose moderation
   * stopped mattering the moment somebody paid.
   *
   * The clock **stops** while the card is down: this is the platform pulling
   * it, so the days the provider cannot use are not billed to them.
   */
  @Post('cards/:cardId/suspend')
  @HttpCode(HttpStatus.OK)
  suspendCard(
    @Param('cardId') cardId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SuspendShowcaseCardDto,
  ) {
    return this.showcase.suspendCard(cardId, user, dto.note ?? null);
  }

  @Post('cards/:cardId/unsuspend')
  @HttpCode(HttpStatus.OK)
  unsuspendCard(@Param('cardId') cardId: string) {
    return this.showcase.unsuspendCard(cardId);
  }
}
