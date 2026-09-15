import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { RolesGuard } from '../auth/roles.guard';
import { DismissProviderReviewReportDto } from './dto/dismiss-provider-review-report.dto';
import { ModerateProviderReviewDto } from './dto/moderate-provider-review.dto';
import { ProviderReviewModerationService } from './provider-review-moderation.service';

const QUEUE_DEFAULT_LIMIT = 50;
const QUEUE_MAX_LIMIT = 100;

/**
 * The operator's side of reviews, on its own prefix: the report queue, one
 * review with everything about it, the decision, and the dismissal. Nothing
 * else is mounted under `/provider-reviews`, so the literal `reports` and the
 * `:reviewId` parameter cannot collide whatever the module order.
 */
@Controller('provider-reviews')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AdminProviderReviewsController {
  constructor(
    @Inject(ProviderReviewModerationService)
    private readonly moderation: ProviderReviewModerationService,
  ) {}

  @Get('reports')
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
  get(@Param('reviewId') reviewId: string) {
    return this.moderation.getForAdmin(reviewId);
  }

  @Post(':reviewId/moderate')
  moderate(
    @Param('reviewId') reviewId: string,
    @Body() dto: ModerateProviderReviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderation.moderate(reviewId, dto, user.id);
  }

  @Post(':reviewId/reports/dismiss')
  dismiss(
    @Param('reviewId') reviewId: string,
    @Body() dto: DismissProviderReviewReportDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderation.dismissReport(reviewId, dto, user.id);
  }
}
