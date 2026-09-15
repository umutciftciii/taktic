import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
import { CreateProviderReviewReportDto } from './dto/create-provider-review-report.dto';
import { ProviderReviewModerationService } from './provider-review-moderation.service';
import { ProviderReviewsService } from './provider-reviews.service';
import { REVIEW_LIST_DEFAULT_LIMIT, REVIEW_LIST_MAX_LIMIT } from './provider-reviews.constants';

/**
 * The provider's own reviews. `ProviderAccessGuard` admits the owning
 * PROVIDER or a SUPER_ADMIN; nothing below checks the caller again. Two
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
   * The reviewed provider flags a comment. The service reads the review
   * under `providerId`, so the guard's owner check is also the "your own
   * review" check: another provider's review is a 404.
   */
  @Post(':reviewId/reports')
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
