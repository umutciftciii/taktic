import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ProviderAccessGuard } from '../auth/provider-access.guard';
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
  constructor(@Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService) {}

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
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= REVIEW_LIST_MAX_LIMIT
    ? parsed
    : REVIEW_LIST_DEFAULT_LIMIT;
}
