import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { OptionalAuthGuard } from '../auth/auth.guard';
import { ProviderReviewsService } from './provider-reviews.service';
import {
  PUBLIC_REVIEW_LIST_MAX_LIMIT,
  REVIEW_LIST_DEFAULT_LIMIT,
} from './provider-reviews.constants';

/**
 * What a visitor sees on the public profile. Three segments after
 * `/providers`, so neither `ProvidersController`'s `GET :id` nor the panel
 * controller's `GET summary` can match it. The guard only attaches the
 * session when there is one; the service decides visibility.
 */
@Controller('providers/:id/reviews/public')
@UseGuards(OptionalAuthGuard)
export class PublicProviderReviewsController {
  constructor(@Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService) {}

  @Get()
  list(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.reviews.listPublic(id, cursor?.trim() || null, parseLimit(limit));
  }
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= PUBLIC_REVIEW_LIST_MAX_LIMIT
    ? parsed
    : Math.min(REVIEW_LIST_DEFAULT_LIMIT, PUBLIC_REVIEW_LIST_MAX_LIMIT);
}
