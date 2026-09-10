import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { AuthUser } from '../auth/auth.types';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { CreateShowcaseLeadDto, ShowcaseLeadVerificationConfirmDto, ShowcaseLeadVerificationStartDto } from './dto/showcase-lead.dto';
import { ShowcaseFeedQueryDto } from './dto/showcase-feed.dto';
import { ShowcaseFeedService } from './showcase-feed.service';
import { ShowcaseLeadService } from './showcase-lead.service';
import { showcaseCardNotFound } from './showcase.errors';

/**
 * The vitrin surface a visitor sees, and the one thing they can do with it.
 *
 * No session is required anywhere on this controller, which is the point: a
 * customer who has never signed in has to be able to read the shelf and write
 * to a business. `OptionalAuthGuard` is used rather than no guard at all so a
 * signed-in customer's request is still attached to their account — and so a
 * PROVIDER session can be recognised and refused by the service.
 *
 * ## What that costs, and what pays for it
 *
 * An open write endpoint is a spam surface. Four things answer it, and none of
 * them is a session:
 *
 * 1. a verified telephone number, mandatory here whatever
 *    `REQUIRE_PHONE_VERIFICATION` says, and redeemable exactly once;
 * 2. a per-number and per-address rate limit;
 * 3. a ten-minute window in which a repeated submission is the same lead;
 * 4. an operator who can refuse the request at any moment, which closes the
 *    lead with it.
 *
 * ## The IDOR note
 *
 * The lead body names a **card**, never a placement and never a provider. The
 * server resolves the live placement from the card id itself. A body that could
 * name a placement would let anyone attach their lead — and the clock that
 * comes with it — to a run somebody else paid for.
 */
@Controller('showcase')
export class ShowcasePublicController {
  constructor(
    @Inject(ShowcaseFeedService) private readonly feed: ShowcaseFeedService,
    @Inject(ShowcaseLeadService) private readonly leads: ShowcaseLeadService,
    @Inject(PhoneVerificationService)
    private readonly phoneVerification: PhoneVerificationService,
  ) {}

  /** The shelf for one place. Refuses without a location — see the service. */
  @Get('feed')
  listFeed(@Query() query: ShowcaseFeedQueryDto) {
    return this.feed.list(query);
  }

  /**
   * One card, and only while it is genuinely on the air.
   *
   * A card that never existed, one whose run has ended and one an operator has
   * pulled all answer the same 404. A card is a business's price list, and a
   * distinguishable "exists but is not published" would let anyone walk the id
   * space and read what competitors are about to advertise.
   */
  @Get('cards/:cardId')
  async getCard(@Param('cardId') cardId: string) {
    const card = await this.feed.getPublicCard(cardId);

    if (!card) {
      throw showcaseCardNotFound();
    }

    return card;
  }

  /**
   * Asks for a verification code before any request exists.
   *
   * Deliberately answers the same way whether or not the number is known to the
   * platform, and never returns the code. The send budgets are the ones the
   * request-bound verification path already uses, on the same window, so this
   * route adds no capacity to a number or an address.
   */
  @Post('lead-verification')
  @HttpCode(HttpStatus.OK)
  startVerification(
    @Body() dto: ShowcaseLeadVerificationStartDto,
    @Req() req: IncomingRequest,
  ) {
    return this.phoneVerification.sendStandaloneCode(dto.phone, readMeta(req));
  }

  @Post('lead-verification/verify')
  @HttpCode(HttpStatus.OK)
  confirmVerification(
    @Body() dto: ShowcaseLeadVerificationConfirmDto,
    @Req() req: IncomingRequest,
  ) {
    return this.phoneVerification.verifyStandaloneCode(dto.phone, dto.code, readMeta(req));
  }

  /**
   * Opens a direct lead on one card.
   *
   * 200 rather than 201 when a repeated submission is answered with the lead
   * that already exists, and 201 when one is genuinely created — the service
   * decides which, and the status follows the fact.
   */
  @Post('cards/:cardId/leads')
  @UseGuards(OptionalAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createLead(
    @Param('cardId') cardId: string,
    @Body() dto: CreateShowcaseLeadDto,
    @CurrentUser() user: AuthUser | null,
    @Req() req: IncomingRequest,
  ) {
    const outcome = await this.leads.createLead(cardId, dto, user ?? null, readMeta(req));
    return outcome.lead;
  }
}

/**
 * Structural subset of the Express request. Declared locally because the API
 * does not depend on @types/express directly — the same approach the phone
 * verification controller and AuthThrottler take.
 */
type IncomingRequest = {
  ip?: unknown;
  headers?: Record<string, unknown>;
};

function readMeta(req: IncomingRequest) {
  const userAgent = req.headers?.['user-agent'];

  return {
    ipAddress: typeof req.ip === 'string' ? req.ip : null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : null,
  };
}
