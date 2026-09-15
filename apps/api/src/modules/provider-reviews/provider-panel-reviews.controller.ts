import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CreateProviderReviewReportDto } from './dto/create-provider-review-report.dto';
import { ProviderReviewModerationService } from './provider-review-moderation.service';
import { ProviderReviewsService } from './provider-reviews.service';
import { REVIEW_LIST_DEFAULT_LIMIT, REVIEW_LIST_MAX_LIMIT } from './provider-reviews.constants';

/**
 * The provider's own reviews. `ProviderAccessGuard` admits the owning
 * PROVIDER or a SUPER_ADMIN; the reads below check the caller no further.
 * The report route alone narrows that to the owner — see `report`. Two
 * segments after `/providers/:providerId`, so `ProvidersController`'s
 * `GET :id` never captures these paths whatever the module order.
 */
@Controller('providers/:providerId/reviews')
@UseGuards(AuthGuard, ProviderAccessGuard)
export class ProviderPanelReviewsController {
  constructor(
    @Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService,
    @Inject(ProviderReviewModerationService)
    private readonly moderation: ProviderReviewModerationService,
  ) {}

  @Get()
  list(
    @Param('providerId') providerId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviews.listForProvider(providerId, cursor?.trim() || null, parseLimit(limit));
  }

  @Get('summary')
  summary(@Param('providerId') providerId: string) {
    return this.reviews.summaryForProvider(providerId);
  }

  /**
   * The reviewed provider flags a comment. A report is the business's own
   * statement about a review of its own work, so unlike the reads above it
   * is not something an operator does on a provider's behalf: the
   * method-level `RolesGuard` runs after the class guards and turns a
   * SUPER_ADMIN into a 403 before the review is looked up, so the answer
   * says nothing about whether the review exists. What gets through is a
   * PROVIDER whom `ProviderAccessGuard` has already bound to `providerId`.
   * The service reads the review under that id, so the owner check is also
   * the "your own review" check: another provider's review is a 404.
   */
  @Post(':reviewId/reports')
  @UseGuards(RolesGuard)
  @Roles(UserRole.PROVIDER)
  report(
    @Param('providerId') providerId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: CreateProviderReviewReportDto,
  ) {
    return this.moderation.reportForProvider(providerId, reviewId, dto);
  }
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= REVIEW_LIST_MAX_LIMIT
    ? parsed
    : REVIEW_LIST_DEFAULT_LIMIT;
}
