import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminPermission } from '@prisma/client';
import { AdminAccessGuard } from '../auth/admin-access.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/auth.decorators';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequiresPermission } from '../auth/permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { DismissProviderReviewReportDto } from './dto/dismiss-provider-review-report.dto';
import { ModerateProviderReviewDto } from './dto/moderate-provider-review.dto';
import { ProviderReviewModerationService } from './provider-review-moderation.service';
import { REVIEW_LIST_DEFAULT_LIMIT, REVIEW_LIST_MAX_LIMIT } from './provider-reviews.constants';
import { ProviderReviewsService } from './provider-reviews.service';

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 100;

/**
 * The operator's side of reviews, on its own prefix: the report queue, one
 * review with everything about it, the decision, and the dismissal. Nothing
 * else is mounted under `/provider-reviews`, so the literal `reports` and the
 * `:reviewId` parameter cannot collide whatever the module order.
 */
@Controller('provider-reviews')
@UseGuards(AuthGuard, AdminAccessGuard, PermissionsGuard)
export class AdminProviderReviewsController {
  constructor(
    @Inject(ProviderReviewModerationService)
    private readonly moderation: ProviderReviewModerationService,
    @Inject(ProviderReviewsService) private readonly reviews: ProviderReviewsService,
  ) {}

  /**
   * One provider's reviews, for the operator's provider page (CMP-006 PR-C.1).
   *
   * Its own route and its own permission rather than a widening of
   * `GET /providers/:providerId/reviews`: that one is the provider panel's,
   * guarded by ownership (`ProviderAccessGuard`), and adding staff to it would
   * grant every staff account a read nobody assigned. Here the read is
   * PROVIDER_REVIEWS_READ, the permission that already covers the review queue.
   * Two segments, so the `:reviewId` route below cannot capture it.
   */
  @Get('by-provider/:providerId')
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_READ)
  listForProvider(
    @Param('providerId') providerId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return this.reviews.listForProvider(
      providerId,
      cursor?.trim() || null,
      Number.isInteger(parsed) && parsed > 0 && parsed <= REVIEW_LIST_MAX_LIMIT ? parsed : REVIEW_LIST_DEFAULT_LIMIT,
    );
  }

  @Get('reports')
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_READ)
  listReports(
    @Query('state') state?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return this.moderation.listQueue(
      state === 'resolved' ? 'resolved' : 'open',
      cursor?.trim() || null,
      Number.isInteger(parsed) && parsed > 0 && parsed <= QUEUE_MAX_LIMIT ? parsed : QUEUE_DEFAULT_LIMIT,
    );
  }

  @Get(':reviewId')
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_READ)
  get(@Param('reviewId') reviewId: string) {
    return this.moderation.getForAdmin(reviewId);
  }

  @Post(':reviewId/moderate')
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_MODERATE)
  moderate(
    @Param('reviewId') reviewId: string,
    @Body() dto: ModerateProviderReviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderation.moderate(reviewId, dto, user.id);
  }

  @Post(':reviewId/reports/dismiss')
  @RequiresPermission(AdminPermission.PROVIDER_REVIEWS_MODERATE)
  dismiss(
    @Param('reviewId') reviewId: string,
    @Body() dto: DismissProviderReviewReportDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderation.dismissReport(reviewId, dto, user.id);
  }
}
